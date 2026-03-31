const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');
const { getStandInfo } = require('./hkt_stands');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Helper: Convert any date/string to ISO format with +07:00 offset
function getHktTime(input = new Date()) {
    const date = typeof input === 'string' ? new Date(input) : input;
    if (isNaN(date.getTime())) return null;
    const hkt = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    return hkt.toISOString().replace(/\.\d{3}Z$/, "+07:00");
}

let flightDataCache = [];
let lastFetchTime = null;

// Track reported final events to prevent duplicate processing
const reportedArrivals = new Map(); // Store flight IDs that perfectly completed (AIBT fired)
const reportedDepartures = new Map(); // Store flight IDs that completely finished (ATD fired)

// trackedArrivals: tracks flights from air -> land -> gate/apron
// id -> { callsign, iata, state: 'AIRBORNE'|'LANDED', ata: null, lastETA: null, zeroSpeedCount: 0, missCount: 0 }
const trackedArrivals = new Map(); 

// trackedDepartures: tracks flights from gate/apron -> taxi -> air
// id -> { callsign, iata, state: 'PARKED'|'TAXIING', aobt: null }
const trackedDepartures = new Map();

const POLLING_INTERVAL = 60 * 1000; // 60 seconds
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const REPORT_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const MISS_THRESHOLD = 3; 
const STAND_RADIUS_METERS = 35; // Radius to consider aircraft "At Gate"
// Multi-zone setup. Note: Only HKT-Ground has onGround: true to restrict massive global ground vehicle polling
const SCAN_ZONES = [
    { name: 'SEA-Close', north: 20.0, west: 90.0, south: 0.0, east: 110.0, options: {} },
    { name: 'West', north: 35.0, west: 45.0, south: 0.0, east: 90.0, options: {} },
    { name: 'North-East', north: 45.0, west: 100.0, south: 20.0, east: 145.0, options: {} },
    { name: 'South', north: 0.0, west: 95.0, south: -25.0, east: 140.0, options: {} },
    // DEDICATED GROUND ZONE FOR HKT (Captures parked & taxiing traffic)
    { name: 'HKT-Ground', north: 8.150, west: 98.250, south: 8.080, east: 98.350, options: { onGround: true, inactive: true } },
];

async function pollRadarData() {
    try {
        console.log(`\n[${new Date().toISOString()}] Ground-Speed Engine scan starting...`);
        const now = new Date();
        
        const flightMap = new Map();
        
        for (const zone of SCAN_ZONES) {
            try {
                const flights = await fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options);
                let zoneHkt = 0;
                for (const f of flights) {
                    if (!flightMap.has(f.id) || zone.name === 'HKT-Ground') {
                        flightMap.set(f.id, f); // HKT-Ground will overwrite air zone copies, providing better ground data
                    }
                    if (f.destination && f.destination.toUpperCase() === 'HKT') zoneHkt++;
                    if (f.origin && f.origin.toUpperCase() === 'HKT') zoneHkt++;
                }
                console.log(`  📡 ${zone.name}: ${flights.length} flights (${zoneHkt} HKT)`);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.log(`  ⚠️ ${zone.name} failed: ${err.message}`);
            }
        }
        
        const allFlights = Array.from(flightMap.values());
        console.log(`  📊 Total unique tracking objects: ${allFlights.length}`);
        
        const responseData = new Map();
        const seenArrivalIds = new Set();
        
        for (const flight of allFlights) {
            const origin = (flight.origin || "").toUpperCase();
            const destination = (flight.destination || "").toUpperCase();
            
            if (origin !== "HKT" && destination !== "HKT") continue;
            
            // If already fully reported logic-wise, skip it totally
            if (reportedArrivals.has(flight.id) || reportedDepartures.has(flight.id)) continue;

            try {
                const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
                const iata = flight.flight || 'UNKNOWN';

                if (destination === "HKT") {
                    // ======================================
                    // ARRIVAL LOGIC (ETA -> ATA -> AIBT)
                    // ======================================
                    seenArrivalIds.add(flight.id);
                    
                    if (!trackedArrivals.has(flight.id)) {
                        trackedArrivals.set(flight.id, { 
                            callsign, iata, state: 'AIRBORNE', ata: null, lastETA: null, zeroSpeedCount: 0, missCount: 0 
                        });
                    }
                    
                    const info = trackedArrivals.get(flight.id);
                    info.missCount = 0; // Reset missing

                    if (info.state === 'AIRBORNE') {
                        // Check Touchdown
                        if (flight.isOnGround || flight.altitude < 100) {
                            info.state = 'LANDED';
                            info.ata = getHktTime();
                            console.log(`  🛬 ${callsign} TOUCHDOWN. Reporting ATA: ${info.ata}`);
                        } else {
                            // Fetch ETA details if airborne
                            try {
                                const detail = await fetchFlight(flight.id);
                                info.lastETA = detail.arrival || detail.scheduledArrival || null;
                            } catch(e) {}
                            await new Promise(r => setTimeout(r, 200));
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, ETA: getHktTime(info.lastETA) });
                        }
                    } 
                    
                    if (info.state === 'LANDED') {
                        // GEOFENCING: Check if aircraft is at a stand
                        const standInfo = getStandInfo(flight.latitude, flight.longitude);
                        
                        if (flight.speed <= 2 && standInfo.distance < STAND_RADIUS_METERS) {
                            // Candidate for AIBT (Stop at Stand)
                            if (!info.potentialAibtTime) {
                                info.potentialAibtTime = getHktTime(); // Record first zero at stand
                            }
                            
                            info.zeroSpeedCount++;
                            if (info.zeroSpeedCount >= 2) {
                                // Confirmed Parked at Stand!
                                const aibt = info.potentialAibtTime;
                                responseData.set(flight.id, { 
                                    Callsign: callsign, 
                                    IATA: iata, 
                                    ATA: info.ata, 
                                    AIBT: aibt,
                                    Stand: standInfo.stand
                                });
                                reportedArrivals.set(flight.id, Date.now());
                                trackedArrivals.delete(flight.id);
                                console.log(`  🛑 ${callsign} PARKED at Stand ${standInfo.stand}. Reporting AIBT: ${aibt}`);
                            } else {
                                responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata, Stand: standInfo.stand });
                            }
                        } else {
                            // Still taxiing or stopped NOT at a stand (Traffic Wait)
                            if (flight.speed > 2) {
                                info.potentialAibtTime = null; // Movement reset
                                info.zeroSpeedCount = 0;
                            }
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata });
                        }
                    }

                } else if (origin === "HKT") {
                    // ======================================
                    // DEPARTURE LOGIC (AOBT -> ATD)
                    // ======================================
                    if (!trackedDepartures.has(flight.id)) {
                        // Defaults to PARKED based on origin alone 
                        trackedDepartures.set(flight.id, { callsign, iata, state: 'PARKED', aobt: null });
                    }
                    
                    const info = trackedDepartures.get(flight.id);

                    if (info.state === 'PARKED') {
                        const standInfo = getStandInfo(flight.latitude, flight.longitude);
                        if (flight.isOnGround && flight.speed > 2) {
                            // Plane was at stand, now moving -> PUSHBACK!
                            info.state = 'TAXIING';
                            info.aobt = getHktTime();
                            console.log(`  🚜 ${callsign} PUSHBACK from Stand ${standInfo.stand}. Reporting AOBT: ${info.aobt}`);
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standInfo.stand });
                        } else if (!flight.isOnGround) {
                            // Fallback if missed ground phase
                            if (flight.altitude < 10000) {
                                info.state = 'AIRBORNE';
                                const atd = getHktTime();
                                responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATD: atd, AOBT: atd });
                                reportedDepartures.set(flight.id, Date.now());
                                trackedDepartures.delete(flight.id);
                                console.log(`  🛫 ${callsign} TOOK OFF (missed taxi). Reporting ATD: ${atd}`);
                            } else {
                                reportedDepartures.set(flight.id, Date.now());
                                trackedDepartures.delete(flight.id);
                            }
                        } else {
                            // Still parked at stand
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, Stand: standInfo.stand });
                        }
                    } 
                    
                    else if (info.state === 'TAXIING') {
                        if (!flight.isOnGround) {
                            // Took off!
                            info.state = 'AIRBORNE';
                            const atd = getHktTime();
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd });
                            reportedDepartures.set(flight.id, Date.now());
                            trackedDepartures.delete(flight.id);
                            console.log(`  🛫 ${callsign} TOOK OFF. Reporting ATD: ${atd}`);
                        } else {
                            // Still taxiing
                            responseData.set(flight.id, { Callsign: callsign, IATA: iata, AOBT: info.aobt });
                        }
                    }
                }

            } catch (err) {
                console.log(`  ⚠️ Error processing ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Handle Disappeared Arrivals (Fallback for ground radar blackspots)
        for (const [id, info] of trackedArrivals.entries()) {
            if (seenArrivalIds.has(id)) continue;
            
            info.missCount++;
            if (info.state === 'AIRBORNE' && info.missCount >= MISS_THRESHOLD) {
                // Plane vanished while airborne -> Assumed Touchdown (e.g. radar drop)
                info.state = 'LANDED';
                info.ata = info.lastETA ? getHktTime(info.lastETA) : getHktTime(); 
                console.log(`  🛬 ${info.callsign} vanished from air. Target ATA: ${info.ata}`);
            }
            
            if (info.state === 'LANDED') {
                 if (info.missCount >= MISS_THRESHOLD * 2) {
                     // Landed but vanished permanently during taxi -> Report just ATA and finish
                     responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ATA: info.ata }); // Push output once
                     reportedArrivals.set(id, Date.now());
                     trackedArrivals.delete(id);
                     console.log(`  🛑 ${info.callsign} lost entirely on ground. Firing final ATA shot.`);
                 } else {
                     // Keep reporting just ATA while missing from ground radar briefly
                     responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ATA: info.ata });
                 }
            } else if (info.state === 'AIRBORNE') {
                 // Still counting misses, keep reporting ETA
                 responseData.set(id, { Callsign: info.callsign, IATA: info.iata, ETA: getHktTime(info.lastETA) });
            }
        }
        
        flightDataCache = Array.from(responseData.values());
        if (flightDataCache.length > 0) Object.freeze(flightDataCache);
        
        lastFetchTime = now;
        console.log(`  📋 Tracking ${trackedArrivals.size} arrivals, ${trackedDepartures.size} departures`);
        console.log(`[${now.toISOString()}] ✅ API Cache populated: ${flightDataCache.length} live outputs`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error: ${error.message}`);
    }
}

// First fetch on startup
pollRadarData();

// Poll every 60 seconds
setInterval(pollRadarData, POLLING_INTERVAL);

// Cleanup stale reported memory
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, timestamp] of reportedArrivals.entries()) {
        if (now - timestamp > REPORT_EXPIRY) {
            reportedArrivals.delete(id); cleaned++;
        }
    }
    for (const [id, timestamp] of reportedDepartures.entries()) {
        if (now - timestamp > REPORT_EXPIRY) {
            reportedDepartures.delete(id); cleaned++;
        }
    }
    for (const [id, info] of trackedDepartures.entries()) {
        if (info.aobt && now - new Date(info.aobt).getTime() > REPORT_EXPIRY) {
            trackedDepartures.delete(id); cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} stale items.`);
}, CLEANUP_INTERVAL);

// ===================================
// API Endpoints
// ===================================
app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheLength: flightDataCache.length, lastFetchTime }));

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v5.5 — Geofencing Stand tracking`);
    console.log(`🌐 Port ${PORT} | Active Zones: ${SCAN_ZONES.length}`);
    console.log(`📍 Loaded Stand Coordinates: ${STAND_RADIUS_METERS}m radius`);
    console.log(`=============================================\n`);
});
