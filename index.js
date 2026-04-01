const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');
const { getStandInfo, STANDS } = require('./hkt_stands');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

/**
 * API Timeout Wrapper: Prevents engine from hanging on slow FR24 responses
 */
async function withTimeout(promise, ms = 30000, label = 'API') {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} Timeout`)), ms));
    return Promise.race([promise, timeout]);
}

// Helper: Convert Server Timestamp (Unix ms) or Date to ISO +07:00
function getHktTime(input) {
    const date = (typeof input === 'number' && input < 2000000000) ? new Date(input * 1000) : new Date(input || Date.now());
    if (isNaN(date.getTime())) return null;
    const hkt = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    return hkt.toISOString().replace(/\.\d{3}Z$/, "+07:00");
}

let flightDataCache = [];
let lastFetchTime = null;
let loopCounts = { GROUND: 0, APPROACH: 0 };

// Persistence maps: flightId -> { data: {Callsign, IATA, ...}, expiry: timestamp }
const recentEvents = new Map(); 

const reportedArrivals = new Set(); // Prevent duplicate firing
const reportedDepartures = new Set();
const trackedArrivals = new Map(); // id -> { callsign, iata, state, ata, lastETA, lastPos, stallingCount, lastSeen }
const trackedDepartures = new Map(); // id -> { callsign, iata, state, aobt, lockedStand, lastSeen }

const APPROACH_INTERVAL = 60 * 1000; 
const GROUND_INTERVAL = 15 * 1000;   
const EVENT_PERSISTENCE_TTL = 5 * 60 * 1000; 
const PURGE_THRESHOLD = 60 * 60 * 1000; // 1 hour: Clear inactive memory

// v7.5 Thresholds: Gate-Locked Accuracy
const AIBT_STAND_RADIUS = 60;        
const AIBT_STABLE_REQUIRED = 2;      
const AOBT_MOVEMENT_THRESHOLD = 15;  
const AOBT_ZERO_SPEED_THRESHOLD = 25; // Displacement required if speed is reported as 0
const AOBT_MIN_DISPLACEMENT = 5;      // Strict requirement for any AOBT (AIQ4115 fix)

// Contiguous Approach Zones
const APPROACH_ZONES = [
    { name: 'HKT-Approach-North', north: 9.5, west: 97.0, south: 8.11, east: 99.5, options: {} },
    { name: 'HKT-Approach-South', north: 8.12, west: 97.0, south: 6.5, east: 99.5, options: {} },
];

const GROUND_ZONES = [
    { name: 'HKT-Full-Ground', north: 8.125, west: 98.295, south: 8.090, east: 98.345, options: { onGround: true, inactive: true } },
];

/**
 * Calculates distance between two WGS-84 points in meters
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; 
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function pollGroup(zones, groupName) {
    try {
        loopCounts[groupName]++;
        console.log(`[${new Date().toISOString()}] Loop [${groupName}] Scanning (#${loopCounts[groupName]})...`);
        const now = new Date().getTime();
        const flightMap = new Map();
        
        for (const zone of zones) {
            try {
                const flights = await withTimeout(fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options), 30000, `Radar-${zone.name}`);
                for (const f of flights) {
                    flightMap.set(f.id, f);
                }
                await new Promise(resolve => setTimeout(resolve, 200)); 
            } catch (err) {
                console.log(`  ⚠️ ${zone.name} radar check failed: ${err.message}`);
            }
        }
        
        await processFlightData(Array.from(flightMap.values()), now, groupName === 'GROUND');
        
        // Heartbeat summary (v7.5 Cleanup)
        if (loopCounts[groupName] % 10 === 0) {
            process.stdout.write(`  💓 [${groupName}] Active: ${trackedArrivals.size + trackedDepartures.size}, Cache: ${recentEvents.size}\n`);
        }
        console.log(`  ✅ [${groupName}] Finished!`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop [${groupName}] Fatal Error: ${error.message}`);
    }
}

async function processFlightData(allFlights, now, isGroundScan) {
    const responseData = new Map();
    const seenInThisPoll = new Set();
    
    // Add current history items to response first
    for (const [id, entry] of recentEvents.entries()) {
        if (now > entry.expiry) {
            recentEvents.delete(id);
        } else {
            responseData.set(id, entry.data);
        }
    }

    const detailPromises = [];

    for (const flight of allFlights) {
        const origin = (flight.origin || "").toUpperCase();
        const destination = (flight.destination || "").toUpperCase();
        const fRawTimestamp = (flight.timestamp || Math.floor(now / 1000)) * 1000;
        
        const isFutureTime = (fRawTimestamp > now + 30000);
        const fTimestamp = isFutureTime ? now : fRawTimestamp;

        const isPhuketDeparture = (origin === "HKT") || (flight.isOnGround && destination !== "" && destination !== "HKT");
        const isPhuketArrival = (destination === "HKT");
        
        if (!isPhuketDeparture && !isPhuketArrival) continue;
        if (reportedArrivals.has(flight.id) || reportedDepartures.has(flight.id)) continue;

        const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
        const iata = flight.flight || 'UNKNOWN';

        try {
            if (isPhuketArrival) {
                seenInThisPoll.add(flight.id);
                if (!trackedArrivals.has(flight.id)) {
                    trackedArrivals.set(flight.id, { 
                        callsign, iata, state: 'AIRBORNE', ata: null, lastETA: null, lastPos: null, stallingCount: 0, lastSeen: fTimestamp 
                    });
                }
                const info = trackedArrivals.get(flight.id);
                info.lastSeen = fTimestamp;
                info.lastPos = { lat: flight.latitude, lon: flight.longitude, speed: flight.speed, ts: fTimestamp };

                if (info.state === 'LANDED' && flight.altitude > 1500) {
                    console.log(`  ♻️ ${callsign} RECOVERY: Resetting to AIRBORNE (Altitude: ${flight.altitude}ft)`);
                    info.state = 'AIRBORNE';
                    info.ata = null;
                    recentEvents.delete(flight.id);
                }

                if (info.state === 'AIRBORNE') {
                    if (!isFutureTime && (flight.isOnGround || flight.altitude < 100) && flight.altitude < 500) {
                        info.state = 'LANDED';
                        info.ata = getHktTime(fTimestamp);
                        console.log(`  🛬 ${callsign} TOUCHDOWN @ ${info.ata}`);
                    } else if (!isGroundScan) {
                        detailPromises.push((async () => {
                            try {
                                const detail = await withTimeout(fetchFlight(flight.id), 30000, `ArrivalDetail-${callsign}`);
                                info.lastETA = detail.arrival || detail.scheduledArrival || null;
                            } catch (e) {}
                        })());
                    }
                    if (!info.ata) {
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ETA: getHktTime(info.lastETA) });
                    }
                } 
                
                if (info.state === 'LANDED') {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    if (flight.speed <= 1.0 && standInfo.distance < AIBT_STAND_RADIUS) {
                        info.stallingCount = (info.stallingCount || 0) + 1;
                        if (info.stallingCount >= AIBT_STABLE_REQUIRED) {
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
                    } else {
                        info.stallingCount = 0;
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: info.ata });
                    }
                }
            } else if (isPhuketDeparture) {
                seenInThisPoll.add(flight.id);
                if (!trackedDepartures.has(flight.id)) {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    const lockedStand = (standInfo.distance < 100) || flight.isOnGround ? standInfo : null; 
                    trackedDepartures.set(flight.id, { callsign, iata, state: 'PARKED', aobt: null, lockedStand, lastSeen: fTimestamp });
                }
                const info = trackedDepartures.get(flight.id);

                if (info.state === 'PARKED') {
                    const currentStand = getStandInfo(flight.latitude, flight.longitude);
                    let displacement = 0;
                    if (info.lockedStand) {
                        displacement = getDistance(flight.latitude, flight.longitude, info.lockedStand.lat || flight.latitude, info.lockedStand.lon || flight.longitude);
                    } else {
                        displacement = currentStand.distance; 
                    }

                    // AOBT (v7.5): Gate-Locked Accuracy
                    const isMovingFast = (flight.speed >= 1.5 && displacement > AOBT_MIN_DISPLACEMENT);
                    const isMovingNormal = (flight.speed >= 0.8 && displacement > AOBT_MOVEMENT_THRESHOLD);
                    const isMovingZeroSpeed = (displacement > AOBT_ZERO_SPEED_THRESHOLD); 

                    if (flight.isOnGround && (isMovingFast || isMovingNormal || isMovingZeroSpeed)) {
                        info.state = 'TAXIING';
                        info.aobt = getHktTime(fTimestamp);
                        const standNr = info.lockedStand ? info.lockedStand.stand : currentStand.stand;
                        const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standNr };
                        responseData.set(flight.id, eventData);
                        recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                        console.log(`  🚜 ${callsign} PUSHBACK detected (Move: ${displacement.toFixed(1)}m, Spd: ${flight.speed}) @ ${info.aobt}`);
                    } else if (!flight.isOnGround) {
                        if (flight.altitude < 15000 && flight.altitude > 0) {
                            info.state = 'AIRBORNE';
                            const atd = getHktTime(fTimestamp);
                            detailPromises.push((async () => {
                                try {
                                    const detail = await withTimeout(fetchFlight(flight.id), 30000, `GhostPushback-${callsign}`);
                                    // Use actual departure if available, but only if it's earlier than takeoff
                                    const actualDepTs = (detail.departure && detail.departure < fRawTimestamp / 1000) ? detail.departure : (info.lastSeen / 1000);
                                    info.aobt = getHktTime(actualDepTs);
                                    console.log(`  👻 ${callsign} GHOST PUSHBACK (Gate-Lock Source) @ ${info.aobt}`);
                                    const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                                    const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                                    responseData.set(flight.id, eventData);
                                    recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                                } catch (e) {
                                    info.aobt = getHktTime(info.lastSeen);
                                    console.log(`  👻 ${callsign} GHOST PUSHBACK (Fallback Source) @ ${info.aobt}`);
                                    const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                                    const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                                    responseData.set(flight.id, eventData);
                                    recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                                }
                            })());
                            reportedDepartures.add(flight.id);
                        } else if (flight.altitude > 15000) {
                            reportedDepartures.add(flight.id);
                            trackedDepartures.delete(flight.id);
                        }
                    } else {
                        // v7.5 GATE-LOCK: Only update lastSeen if still at the stand
                        if (currentStand.distance < AIBT_STAND_RADIUS) {
                            info.lastSeen = fTimestamp;
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
    
    // Wait for all detail/ETA requests to finish in parallel
    if (detailPromises.length > 0) {
        await Promise.all(detailPromises);
    }

    // Ground persistence logic (Arrival Ghosts)
    if (isGroundScan) {
        for (const [id, info] of trackedArrivals.entries()) {
            if (seenInThisPoll.has(id)) continue;
            if (info.state === 'LANDED') {
                 const lastPos = info.lastPos;
                 if (lastPos) {
                     const standInfo = getStandInfo(lastPos.lat, lastPos.lon);
                     if (standInfo.distance < AIBT_STAND_RADIUS && lastPos.speed < 5) {
                         const aibt = getHktTime(lastPos.ts);
                         const eventData = { Callsign: info.callsign, IATA: info.iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                         responseData.set(id, eventData);
                         recentEvents.set(id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                         reportedArrivals.add(id);
                         trackedArrivals.delete(id);
                         console.log(`  👻 ${info.callsign} GHOST ARRIVAL @ ${aibt}`);
                     }
                 }
            }
            // Memory Cleanup (Arrivals)
            if (now - info.lastSeen > PURGE_THRESHOLD) trackedArrivals.delete(id);
        }
        
        // Memory Cleanup (Departures)
        for (const [id, info] of trackedDepartures.entries()) {
            if (now - info.lastSeen > PURGE_THRESHOLD) trackedDepartures.delete(id);
        }
    }

    flightDataCache = Array.from(responseData.values());
    lastFetchTime = new Date();
}

// Polling intervals
setInterval(() => pollGroup(APPROACH_ZONES, 'APPROACH'), APPROACH_INTERVAL);
setInterval(() => pollGroup(GROUND_ZONES, 'GROUND'), GROUND_INTERVAL);

// Initial triggers
pollGroup(APPROACH_ZONES, 'APPROACH');
setTimeout(() => pollGroup(GROUND_ZONES, 'GROUND'), 2000); 

app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ status: 'ok', cacheLength: flightDataCache.length, lastFetchTime, tracking: trackedArrivals.size + trackedDepartures.size }));

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v7.5 — Gate-Locked Fix`);
    console.log(`🌐 Port ${PORT} | Apron: 15s | Approach: 60s`);
    console.log(`🛡️  Ghost Pushback: Using Locked Stand Time`);
    console.log(`=============================================\n`);
});
