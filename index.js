const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');
const { getStandInfo, STANDS } = require('./hkt_stands');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());

// v9.6: Rate Limiting (30 requests/min per IP — no library needed)
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
setInterval(() => rateLimitMap.clear(), RATE_LIMIT_WINDOW);

app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const count = (rateLimitMap.get(ip) || 0) + 1;
    rateLimitMap.set(ip, count);
    if (count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests. Try again in 1 minute.' });
    }
    next();
});

// v9.6: Crash Guard — Prevents total process death from unexpected errors
process.on('uncaughtException', (err) => {
    console.error(`[${new Date().toISOString()}] 💀 UNCAUGHT EXCEPTION: ${err.message}`);
    console.error(err.stack);
    // Don't exit — let the engine keep running
});
process.on('unhandledRejection', (reason) => {
    console.error(`[${new Date().toISOString()}] 💀 UNHANDLED REJECTION: ${reason}`);
    // Don't exit — let the engine keep running
});

/**
 * API Timeout Wrapper: Prevents engine from hanging on slow FR24 responses
 */
async function withTimeout(promise, ms = 30000, label = 'API') {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} Timeout`)), ms));
    return Promise.race([promise, timeout]);
}

/**
 * v8.5 Helper: Strips leading zeros from numeric part of flight numbers/callsigns
 * Examples: JQ071 -> JQ71, WK051 -> WK51
 */
function normalizeFlightNumber(str) {
    if (!str) return '';
    return str.replace(/([A-Z]+)0+([1-9]\d*)/i, '$1$2').toUpperCase();
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

// Persistence maps: flightId -> { data: {Callsign, IATA, ...}, expiry: timestamp }
const recentEvents = new Map(); 

const reportedArrivals = new Set(); // Prevent duplicate firing
const reportedDepartures = new Set();
const trackedArrivals = new Map(); // id -> { callsign, iata, state, ata, lastETA, lastPos, stallingCount, lastSeen }
const trackedDepartures = new Map(); // id -> { callsign, iata, state, aobt, lockedStand, lastSeen, stallingCount }

const APPROACH_INTERVAL = 30000;     
const GROUND_INTERVAL = 8000;        
const EVENT_PERSISTENCE_TTL = 5 * 60 * 1000; 
const PURGE_THRESHOLD = 60 * 60 * 1000; // 1 hour: Clear inactive memory

// v8.7 Dynamic Thresholds (Stability First)
const AIBT_STABLE_REQUIRED = 2;      
const AOBT_MOVEMENT_THRESHOLD = 25;  
const AOBT_ZERO_SPEED_THRESHOLD = 35; 
const AOBT_MIN_DISPLACEMENT = 15;     
const AOBT_STABLE_REQUIRED = 3;      

// v8.5-8.9 Configs
const CARRIER_WHITELIST = ['JQ', 'WK', 'JST', 'EDW'];
const BLACKLIST_CALLSIGNS = ['SITEMON', 'VTSPTWR', 'VTSPGND', 'TWR', 'GND'];

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
        
        // v9.0 Clean Logs (Removed #Count)
        const totalTracking = trackedArrivals.size + trackedDepartures.size;
        console.log(`[${new Date().toISOString()}] Loop [${groupName}] | Active: ${totalTracking} | Found: ${flightMap.size} | Cache: ${recentEvents.size}`);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Loop [${groupName}] Fatal Error: ${error.message}`);
    }
}

// v9.1: Processing Lock — Prevents GROUND and APPROACH from interleaving
let processLock = Promise.resolve();

async function processFlightData(allFlights, now, isGroundScan) {
    const ticket = processLock;
    let releaseLock;
    processLock = new Promise(resolve => { releaseLock = resolve; });
    await ticket;

    try {
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

        // v8.9: Improved identification (Registration fallback)
        const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
        const normCallsign = normalizeFlightNumber(callsign);
        
        // v8.8 Filter: Ignore non-aircraft transponders (Tower/SITEMON)
        if (BLACKLIST_CALLSIGNS.includes(normCallsign)) continue;

        const isWhitelisted = CARRIER_WHITELIST.some(prefix => normCallsign.startsWith(prefix));

        // v9.1 JST72 Fix: Whitelisted flights stationary at a gate = DEPARTURE, not arrival
        let isStationaryAtGate = false;
        if (isGroundScan && isWhitelisted && flight.speed <= 1) {
            const gateCheck = getStandInfo(flight.latitude, flight.longitude);
            isStationaryAtGate = gateCheck.distance < gateCheck.radius;
        }

        let isPhuketDeparture = (isGroundScan && flight.isOnGround) || (origin === "HKT") || (flight.isOnGround && destination !== "" && destination !== "HKT");
        let isPhuketArrival = (destination === "HKT") || (isGroundScan && isWhitelisted && !isStationaryAtGate);
        
        // v9.4: Strict Stickiness (State Lock). Prevent hijacking!
        if (trackedDepartures.has(flight.id)) {
            isPhuketArrival = false;
            isPhuketDeparture = true;
        } else if (trackedArrivals.has(flight.id)) {
            isPhuketDeparture = false;
            isPhuketArrival = true;
        }
        
        if (!isPhuketDeparture && !isPhuketArrival) continue;
        if (reportedArrivals.has(flight.id) || reportedDepartures.has(flight.id)) continue;

        const iata = flight.flight || flight.registration || 'UNKNOWN';

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
                        console.log(`  [EVENT] [M13] 🛬 ${callsign} TOUCHDOWN (ATA: ${info.ata})`);
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
                    if (flight.speed <= 1.0 && standInfo.distance < standInfo.radius) {
                        info.stallingCount = (info.stallingCount || 0) + 1;
                        if (info.stallingCount >= AIBT_STABLE_REQUIRED) {
                            const aibt = getHktTime(fTimestamp);
                            const eventData = { Callsign: callsign, IATA: iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            reportedArrivals.add(flight.id);
                            trackedArrivals.delete(flight.id);
                            console.log(`  [EVENT] [M14] 🛑 ${callsign} PARKED (AIBT: ${aibt}) | Stand: ${standInfo.stand} (Radius: ${standInfo.radius}m)`);
                        } else {
                            responseData.set(flight.id, { Callsign: callsign, iata: iata, ATA: info.ata });
                        }
                    } else {
                        info.stallingCount = 0;
                        responseData.set(flight.id, { Callsign: callsign, iata: iata, ATA: info.ata });
                    }
                }
            } else if (isPhuketDeparture) {
                seenInThisPoll.add(flight.id);
                if (!trackedDepartures.has(flight.id)) {
                    const standInfo = getStandInfo(flight.latitude, flight.longitude);
                    const lockedStand = (standInfo.distance < 100) || flight.isOnGround ? standInfo : null; 
                    trackedDepartures.set(flight.id, { callsign, iata, state: 'PARKED', aobt: null, lockedStand, lastSeen: fTimestamp, stallingCount: 0 });
                }
                const info = trackedDepartures.get(flight.id);

                if (info.state === 'PARKED') {
                    const currentStand = getStandInfo(flight.latitude, flight.longitude);
                    let displacement = 0;
                    if (info.lockedStand && info.lockedStand.lat) {
                        displacement = getDistance(flight.latitude, flight.longitude, info.lockedStand.lat, info.lockedStand.lon);
                    } else {
                        displacement = currentStand.distance; 
                    }

                    // AOBT (v8.2-v8.7 Balance): Anti-Drift Thresholds
                    const isMovingFast = (flight.speed >= 1.5 && displacement > AOBT_MIN_DISPLACEMENT);
                    const isMovingNormal = (flight.speed >= 0.8 && displacement > AOBT_MOVEMENT_THRESHOLD);
                    const isMovingZeroSpeed = (displacement > AOBT_ZERO_SPEED_THRESHOLD); 

                    if (flight.isOnGround && (isMovingFast || isMovingNormal || isMovingZeroSpeed)) {
                        info.stallingCount = (info.stallingCount || 0) + 1;
                        if (info.stallingCount >= AOBT_STABLE_REQUIRED || displacement > 40) {
                            info.state = 'TAXIING';
                            info.aobt = getHktTime(fTimestamp);
                            const standNr = info.lockedStand ? info.lockedStand.stand : currentStand.stand;
                            const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, Stand: standNr };
                            responseData.set(flight.id, eventData);
                            recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                            console.log(`  [EVENT] [M11] 🚜 ${callsign} PUSHBACK detected (Move: ${displacement.toFixed(1)}m, Spd: ${flight.speed}) (AOBT: ${info.aobt}) | Stand: ${standNr}`);
                        }
                    } else if (!flight.isOnGround) {
                        if (flight.altitude < 15000 && flight.altitude > 0) {
                            info.state = 'AIRBORNE';
                            const atd = getHktTime(fTimestamp);
                            detailPromises.push((async () => {
                                try {
                                    const detail = await withTimeout(fetchFlight(flight.id), 30000, `GhostPushback-${callsign}`);
                                    const actualDepTs = (detail.departure && detail.departure < fRawTimestamp / 1000) ? detail.departure : (info.lastSeen / 1000);
                                    info.aobt = getHktTime(actualDepTs);
                                    const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                                    console.log(`  [EVENT] [M11] 👻 ${callsign} GHOST PUSHBACK (Gate-Lock Source) (AOBT: ${info.aobt}) | Stand: ${standNr}`);
                                    const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                                    responseData.set(flight.id, eventData);
                                    recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                                } catch (e) {
                                    info.aobt = getHktTime(info.lastSeen);
                                    const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                                    console.log(`  [EVENT] [M11] 👻 ${callsign} GHOST PUSHBACK (Fallback Source) (AOBT: ${info.aobt}) | Stand: ${standNr}`);
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
                        info.stallingCount = 0;
                        if (currentStand.distance < currentStand.radius) {
                            info.lastSeen = fTimestamp;
                        }
                    }
                } else if (info.state === 'TAXIING') {
                    if (!flight.isOnGround) {
                        info.state = 'AIRBORNE';
                        const atd = getHktTime(fTimestamp);
                        const standNr = info.lockedStand ? info.lockedStand.stand : 'UNKNOWN';
                        const eventData = { Callsign: callsign, IATA: iata, AOBT: info.aobt, ATD: atd, Stand: standNr };
                        responseData.set(flight.id, eventData);
                        recentEvents.set(flight.id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                        reportedDepartures.add(flight.id);
                        trackedDepartures.delete(flight.id);
                        console.log(`  [EVENT] [M12] 🛫 ${callsign} TOOK OFF (AOBT: ${info.aobt} | ATD: ${atd}) | Stand: ${standNr}`);
                    } else {
                        responseData.set(flight.id, { Callsign: callsign, iata: iata, AOBT: info.aobt });
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
                     if (standInfo.distance < standInfo.radius && lastPos.speed < 5) {
                         const aibt = getHktTime(lastPos.ts);
                         const eventData = { Callsign: info.callsign, IATA: info.iata, ATA: info.ata, AIBT: aibt, Stand: standInfo.stand };
                         responseData.set(id, eventData);
                         recentEvents.set(id, { data: eventData, expiry: now + EVENT_PERSISTENCE_TTL });
                         reportedArrivals.add(id);
                         trackedArrivals.delete(id);
                         console.log(`  [EVENT] [M14] 👻 ${info.callsign} GHOST ARRIVAL (AIBT: ${aibt}) | Stand: ${standInfo.stand}`);
                     }
                 }
            }
            if (now - info.lastSeen > PURGE_THRESHOLD) trackedArrivals.delete(id);
        }
        for (const [id, info] of trackedDepartures.entries()) {
            if (now - info.lastSeen > PURGE_THRESHOLD) trackedDepartures.delete(id);
        }
    }

    flightDataCache = Array.from(responseData.values());
    lastFetchTime = new Date();

    } finally { releaseLock(); } // v9.1: Release processing lock
}

// v9.5: Memory Purge — Clear stale IDs every 3 days to prevent memory leak
const MEMORY_PURGE_INTERVAL = 3 * 24 * 60 * 60 * 1000; // 3 days
setInterval(() => {
    const beforeA = reportedArrivals.size;
    const beforeD = reportedDepartures.size;
    reportedArrivals.clear();
    reportedDepartures.clear();
    console.log(`[${new Date().toISOString()}] 🧹 Memory Purge: Cleared ${beforeA} arrivals + ${beforeD} departures`);
}, MEMORY_PURGE_INTERVAL);

setInterval(() => pollGroup(APPROACH_ZONES, 'APPROACH'), APPROACH_INTERVAL);
setInterval(() => pollGroup(GROUND_ZONES, 'GROUND'), GROUND_INTERVAL);

pollGroup(APPROACH_ZONES, 'APPROACH');
setTimeout(() => pollGroup(GROUND_ZONES, 'GROUND'), 2000); 

app.get('/api/flights/eta', (req, res) => res.json(flightDataCache));
app.get('/api/external/flights', (req, res) => {
    if (req.headers['x-api-key'] !== 'hkt-apron-static-key') return res.status(401).json({ error: 'Unauthorized' });
    res.json(flightDataCache);
});
app.get('/api/health', (req, res) => res.json({ 
    status: 'ok', 
    version: 'v9.6',
    uptime: Math.floor(process.uptime()) + 's',
    cacheLength: flightDataCache.length, 
    lastFetchTime, 
    tracking: trackedArrivals.size + trackedDepartures.size,
    memoryArrivals: reportedArrivals.size,
    memoryDepartures: reportedDepartures.size
}));

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v9.6 — Production Armor`);
    console.log(`🌐 Port ${PORT} | Apron: 8s | Approach: 30s`);
    console.log(`🛡️  RateLimit: 30/min | CrashGuard: ON`);
    console.log(`=============================================\n`);
});
