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

// Persistence maps: flightId -> { data: {Callsign, IATA, ...}, expiry: timestamp }
const recentEvents = new Map(); 

const reportedArrivals = new Set(); // Prevent duplicate firing
const reportedDepartures = new Set();
const trackedArrivals = new Map(); // id -> { callsign, iata, state, ata, lastETA, lastPos: {lat, lon, speed, ts}, missCount }
const trackedDepartures = new Map(); // id -> { callsign, iata, state, aobt }

const POLLING_INTERVAL = 15 * 1000; // High-Frequency (15s) for Terminal monitoring (v6.4)
const CLEANUP_INTERVAL = 60 * 60 * 1000;
const REPORT_EXPIRY = 24 * 60 * 60 * 1000;
const EVENT_PERSISTENCE_TTL = 5 * 60 * 1000; // Keep events in API for 5 minutes
const MISS_THRESHOLD = 3; 
const MAX_LANDED_MISSES = 45; 
const STAND_RADIUS_METERS = 35; 

// Focused HKT local zones to reduce total scan requests while increasing frequency
const SCAN_ZONES = [
    { name: 'HKT-Approach', north: 8.6, west: 97.8, south: 7.7, east: 98.8, options: {} },
    { name: 'HKT-Ground', north: 8.150, west: 98.250, south: 8.080, east: 98.350, options: { onGround: true, inactive: true } },
];

async function pollRadarData() {
    try {
        console.log(`\n[${new Date().toISOString()}] Terminal Engine (v6.4) scanning (15s)...`);
        const now = new Date().getTime();
        const flightMap = new Map();
        
        for (const zone of SCAN_ZONES) {
            try {
                const flights = await fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options);
                for (const f of flights) {
                    if (!flightMap.has(f.id) || zone.name === 'HKT-Ground') {
                        flightMap.set(f.id, f);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 200)); 
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
                            console.log(`  🛬 ${callsign} TOUCHDOWN @ ${info.ata}`);
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
                        if (flight.speed <= 1.0 && standInfo.distance < STAND_RADIUS_METERS) {
                            const aibt = getHktTime(fTimestamp);
                            const eventData = { Callsign: callsign, IATA: iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            reportedArrivals.add(flight.id);
                            trackedArrivals.delete(flight.id);
                            console.log(`  🛑 ${callsign} PARKED @ ${aibt}`);
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
                        // AOBT (v6.4): Robust Logic -> Dual trigger: Speed >= 2.0 OR (Speed >= 1.0 AND Distance > 35m)
                        if (flight.isOnGround && (flight.speed >= 2.0 || (flight.speed >= 1.0 && standInfo.distance > 35))) {
                            info.state = 'TAXIING';
                            info.aobt = getHktTime(fTimestamp);
                            const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standInfo.stand };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            console.log(`  🚜 ${callsign} PUSHBACK detected @ ${info.aobt}`);
                        } else if (!flight.isOnGround) {
                            if (flight.altitude < 10000) {
                                info.state = 'AIRBORNE';
                                const atd = getHktTime(fTimestamp);
                                const eventData = { Callsign: callsign, IATA: iata, ATD: atd, AOBT: atd || getHktTime(fTimestamp) };
                                responseData.set(flight.id, eventData);
                                recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                                reportedDepartures.add(flight.id);
                                trackedDepartures.delete(flight.id);
                                console.log(`  🛫 ${callsign} TOOK OFF (missed taxi) @ ${atd}`);
                            } else {
                                reportedDepartures.add(flight.id);
                                trackedDepartures.delete(flight.id);
                            }
                        }
                    } else if (info.state === 'TAXIING') {
                        if (!flight.isOnGround) {
                            info.state = 'AIRBORNE';
                            const atd = getHktTime(fTimestamp);
                            const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            reportedDepartures.add(flight.id);
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
        
        // Ghost Block / Disappeared Arrivals
        for (const [id, info] of trackedArrivals.entries()) {
            if (seenArrivalIds.has(id)) continue;
            info.missCount++;
            
            if (info.state === 'AIRBORNE' && info.missCount >= MISS_THRESHOLD) {
                info.state = 'LANDED';
                info.ata = info.lastETA ? getHktTime(info.lastETA) : getHktTime(); 
                console.log(`  🛬 ${info.callsign} vanished. Assigned ATA: ${info.ata}`);
            }
            
            if (info.state === 'LANDED') {
                 const lastPos = info.lastPos;
                 if (lastPos) {
                     const standInfo = getStandInfo(lastPos.lat, lastPos.lon);
                     if (standInfo.distance < 40 && lastPos.speed < 5) {
                         const aibt = getHktTime(lastPos.ts);
                         const eventData = { Callsign: info.callsign, IATA: info.iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                         responseData.set(id, eventData);
                         recentEvents.set(id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                         reportedArrivals.add(id);
                         trackedArrivals.delete(id);
                         console.log(`  👻 ${info.callsign} GHOST BLOCK @ ${aibt}`);
                         continue;
                     }
                 }

                 if (info.missCount >= MAX_LANDED_MISSES) {
                     const eventData = { Callsign: info.callsign, IATA: info.iata, ATA: info.ata };
                     responseData.set(id, eventData);
                     recentEvents.set(id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                     reportedArrivals.add(id);
                     trackedArrivals.delete(id);
                     console.log(`  🗑️ ${info.callsign} persistence timeout.`);
                 } else {
                     responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ATA: info.ata });
                 }
            } else {
                 responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ETA: getHktTime(info.lastETA) });
            }
        }

        // Merge Recent Finished Events (5 min history)
        for (const [id, entry] of recentEvents.entries()) {
            if (now > entry.expiry) {
                recentEvents.delete(id);
            } else {
                responseData.set(id, entry.data);
            }
        }
        
        flightDataCache = Array.from(responseData.values());
        if (flightDataCache.length > 0) Object.freeze(flightDataCache);
        lastFetchTime = new Date();
        console.log(`  📋 Active: Arr=${trackedArrivals.size}, Dep=${trackedDepartures.size}, History=${recentEvents.size}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop Error: ${error.message}`);
    }
}

pollRadarData();
setInterval(pollRadarData, POLLING_INTERVAL);

setInterval(() => {
    // Large repo cleanup every hour
    const now = Date.now();
    let cleaned = 0;
    // reportedArrivals and reportedDepartures only grow slowly, but we can clear every 24h if needed. 
    // For now, persistence is handled by recentEvents.
}, CLEANUP_INTERVAL);

app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheLength: flightDataCache.length, lastFetchTime }));

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v6.4 — 15s Terminal Active`);
    console.log(`🌐 Port ${PORT} | Polling: 15s | History: 5m`);
    console.log(`📍 Robust AOBT Logic: Speed 2.0 or 1.0 @ 35m`);
    console.log(`=============================================\n`);
});
