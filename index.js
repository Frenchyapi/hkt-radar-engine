const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');
const { getStandInfo } = require('./hkt_stands');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Helper: Convert Server Timestamp (Unix ms) or Date to ISO +07:00
function getHktTime(input) {
    const date = input ? new Date(input) : new Date();
    if (isNaN(date.getTime())) return null;
    const hkt = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    return hkt.toISOString().replace(/\.\d{3}Z$/, "+07:00");
}

let flightDataCache = [];
let lastFetchTime = null;

const reportedArrivals = new Map(); 
const reportedDepartures = new Map();
const trackedArrivals = new Map(); // id -> { callsign, iata, state, ata, lastETA, lastPos: {lat, lon, speed, ts}, missCount }
const trackedDepartures = new Map(); // id -> { callsign, iata, state, aobt }

const POLLING_INTERVAL = 60 * 1000;
const CLEANUP_INTERVAL = 60 * 60 * 1000;
const REPORT_EXPIRY = 24 * 60 * 60 * 1000;
const MISS_THRESHOLD = 3; 
const MAX_LANDED_MISSES = 45; 
const STAND_RADIUS_METERS = 35; // Increased buffer for Code C/E antenna offset

const SCAN_ZONES = [
    { name: 'SEA-Close', north: 20.0, west: 90.0, south: 0.0, east: 110.0, options: {} },
    { name: 'West', north: 35.0, west: 45.0, south: 0.0, east: 90.0, options: {} },
    { name: 'North-East', north: 45.0, west: 100.0, south: 20.0, east: 145.0, options: {} },
    { name: 'South', north: 0.0, west: 95.0, south: -25.0, east: 140.0, options: {} },
    { name: 'HKT-Ground', north: 8.150, west: 98.250, south: 8.080, east: 98.350, options: { onGround: true, inactive: true } },
];

async function pollRadarData() {
    try {
        console.log(`\n[${new Date().toISOString()}] Precision Engine (v6.0) scanning...`);
        const now = new Date();
        const flightMap = new Map();
        
        for (const zone of SCAN_ZONES) {
            try {
                const flights = await fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options);
                for (const f of flights) {
                    if (!flightMap.has(f.id) || zone.name === 'HKT-Ground') {
                        flightMap.set(f.id, f);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.log(`  ⚠️ ${zone.name} failed: ${err.message}`);
            }
        }
        
        const allFlights = Array.from(flightMap.values());
        const responseData = new Map();
        const seenArrivalIds = new Set();
        const seenDepartureIds = new Set();
        
        for (const flight of allFlights) {
            const origin = (flight.origin || "").toUpperCase();
            const destination = (flight.destination || "").toUpperCase();
            const fTimestamp = (flight.timestamp || Math.floor(Date.now() / 1000)) * 1000;
            
            const isPhuketDeparture = (origin === "HKT") || (flight.isOnGround && destination !== "" && destination !== "HKT");
            const isPhuketArrival = (destination === "HKT");
            
            if (!isPhuketDeparture && !isPhuketArrival) continue;
            if (reportedArrivals.has(flight.id) || reportedDepartures.has(flight.id)) continue;

            const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
            const iata = flight.flight || 'UNKNOWN';

            try {
                if (isPhuketArrival) {
                    seenArrivalIds.add(flight.id);
                    if (!trackedArrivals.has(flight.id)) {
                        trackedArrivals.set(flight.id, { 
                            callsign, iata, state: 'AIRBORNE', ata: null, lastETA: null, lastPos: null, missCount: 0 
                        });
                    }
                    const info = trackedArrivals.get(flight.id);
                    info.missCount = 0;
                    info.lastPos = { lat: flight.latitude, lon: flight.longitude, speed: flight.speed, ts: fTimestamp };

                    if (info.state === 'AIRBORNE') {
                        if (flight.isOnGround || flight.altitude < 100) {
                            info.state = 'LANDED';
                            info.ata = getHktTime(fTimestamp);
                            console.log(`  🛬 ${callsign} TOUCHDOWN @ ${info.ata} (Server Time)`);
                        } else {
                            try {
                                const detail = await fetchFlight(flight.id);
                                info.lastETA = detail.arrival || detail.scheduledArrival || null;
                            } catch(e) {}
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, ETA: getHktTime(info.lastETA) });
                        }
                    } 
                    
                    if (info.state === 'LANDED') {
                        const standInfo = getStandInfo(flight.latitude, flight.longitude);
                        // AIBT Capture: Immediately on first stationary poll at stand (v6.0 improvement)
                        if (flight.speed < 1.0 && standInfo.distance < STAND_RADIUS_METERS) {
                            const aibt = getHktTime(fTimestamp);
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand });
                            reportedArrivals.set(flight.id, Date.now());
                            trackedArrivals.delete(flight.id);
                            console.log(`  🛑 ${callsign} PARKED at Stand ${standInfo.stand} @ ${aibt}`);
                        } else {
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata });
                        }
                    }
                } else if (isPhuketDeparture) {
                    seenDepartureIds.add(flight.id);
                    if (!trackedDepartures.has(flight.id)) {
                        trackedDepartures.set(flight.id, { callsign, iata, state: 'PARKED', aobt: null });
                    }
                    const info = trackedDepartures.get(flight.id);

                    if (info.state === 'PARKED') {
                        const standInfo = getStandInfo(flight.latitude, flight.longitude);
                        // AOBT Capture: Robust detection (speed >= 1.5 AND moved away 15m) to avoid tug-jiggles
                        if (flight.isOnGround && (flight.speed >= 1.5 && standInfo.distance > 15)) {
                            info.state = 'TAXIING';
                            info.aobt = getHktTime(fTimestamp);
                            console.log(`  🚜 ${callsign} PUSHBACK from Stand ${standInfo.stand} @ ${info.aobt}`);
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standInfo.stand });
                        } else if (!flight.isOnGround) {
                            if (flight.altitude < 10000) {
                                info.state = 'AIRBORNE';
                                const atd = getHktTime(fTimestamp);
                                responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATD: atd, AOBT: atd });
                                reportedDepartures.set(flight.id, Date.now());
                                trackedDepartures.delete(flight.id);
                                console.log(`  🛫 ${callsign} TOOK OFF (missed taxi) @ ${atd}`);
                            } else {
                                reportedDepartures.set(flight.id, Date.now());
                                trackedDepartures.delete(flight.id);
                            }
                        }
                    } else if (info.state === 'TAXIING') {
                        if (!flight.isOnGround) {
                            info.state = 'AIRBORNE';
                            const atd = getHktTime(fTimestamp);
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd });
                            reportedDepartures.set(flight.id, Date.now());
                            trackedDepartures.delete(flight.id);
                            console.log(`  🛫 ${callsign} TOOK OFF @ ${atd}`);
                        } else {
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt });
                        }
                    }
                }
            } catch (err) {
                console.log(`  ⚠️ Error processing ${callsign}: ${err.message}`);
            }
        }
        
        // Handle Disappeared Arrivals (Ghost Block / Patience)
        for (const [id, info] of trackedArrivals.entries()) {
            if (seenArrivalIds.has(id)) continue;
            info.missCount++;
            
            if (info.state === 'AIRBORNE' && info.missCount >= MISS_THRESHOLD) {
                info.state = 'LANDED';
                info.ata = info.lastETA ? getHktTime(info.lastETA) : getHktTime(); 
                console.log(`  🛬 ${info.callsign} vanished from air. Assigned ATA: ${info.ata}`);
            }
            
            if (info.state === 'LANDED') {
                 // GHOST BLOCK: If vanished while slow and near a stand, assume it parked
                 const lastPos = info.lastPos;
                 if (lastPos) {
                     const standInfo = getStandInfo(lastPos.lat, lastPos.lon);
                     if (standInfo.distance < 40 && lastPos.speed < 5) {
                         const aibt = getHktTime(lastPos.ts);
                         responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand });
                         reportedArrivals.set(id, Date.now());
                         trackedArrivals.delete(id);
                         console.log(`  👻 ${info.callsign} GHOST BLOCK! Vanished at Stand ${standInfo.stand}. Using AIBT: ${aibt}`);
                         continue;
                     }
                 }

                 if (info.missCount >= MAX_LANDED_MISSES) {
                     responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ATA: info.ata });
                     reportedArrivals.set(id, Date.now());
                     trackedArrivals.delete(id);
                     console.log(`  🗑️ ${info.callsign} timeout (45m). Final ATA fire.`);
                 } else {
                     responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ATA: info.ata });
                 }
            } else {
                 responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ETA: getHktTime(info.lastETA) });
            }
        }
        
        flightDataCache = Array.from(responseData.values());
        if (flightDataCache.length > 0) Object.freeze(flightDataCache);
        lastFetchTime = now;
        console.log(`  📋 Active Tracking: Arrivals=${trackedArrivals.size}, Departures=${trackedDepartures.size}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop Error: ${error.message}`);
    }
}

pollRadarData();
setInterval(pollRadarData, POLLING_INTERVAL);

setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    const cleanRepo = (map) => { for (const [id, ts] of map.entries()) { if (now - ts > REPORT_EXPIRY) { map.delete(id); cleaned++; } } };
    cleanRepo(reportedArrivals); cleanRepo(reportedDepartures);
    if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} stale items.`);
}, CLEANUP_INTERVAL);

app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheLength: flightDataCache.length, lastFetchTime }));

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v6.0 — Precision Timing`);
    console.log(`🌐 Port ${PORT} | Active Zones: ${SCAN_ZONES.length}`);
    console.log(`📍 Stand Radius: ${STAND_RADIUS_METERS}m | Precision: Server Timestamp`);
    console.log(`=============================================\n`);
});
