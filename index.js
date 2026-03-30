const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// Helper: Get current time in ISO format with +07:00 offset
function getHktTime(date = new Date()) {
    // Add 7 hours to UTC to get HKT, then format
    const hkt = new Date(date.getTime() + (7 * 60 * 60 * 1000));
    return hkt.toISOString().replace(/\.\d{3}Z$/, "+07:00");
}


// In-memory Cache & State
let flightDataCache = [];
let lastFetchTime = null;
const reportedLandedFlights = new Map(); // Store flight IDs that have already reported ATA
const reportedDepartedFlights = new Map(); // Store flight IDs that have already reported ATD
const trackedArrivals = new Map(); // Track HKT-bound flights across polls: id -> { callsign, iata, lastETA, missCount }
const POLLING_INTERVAL = 60 * 1000; // 60 seconds
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const REPORT_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours
const ATA_WINDOW_MS = 15 * 60 * 1000; // 15 minutes - max gap between ETA and now to consider it a real landing
const MISS_THRESHOLD = 3; // Must be missing from radar for 3 consecutive polls (~3 min) before confirming landing

/**
 * Multiple scanning zones to beat the 1500-flight cap.
 * Each zone returns up to 1500 flights independently.
 * We merge all results and deduplicate by flight ID.
 * Format: fetchFromRadar(north, west, south, east)
 */
const SCAN_ZONES = [
    // Zone 1: Close range - Thailand & neighbors (catches all nearby HKT flights)
    { name: 'SEA-Close', north: 20.0, west: 90.0, south: 0.0, east: 110.0 },
    // Zone 2: India, Sri Lanka, Middle East  
    { name: 'West', north: 35.0, west: 45.0, south: 0.0, east: 90.0 },
    // Zone 3: China, Korea, Japan
    { name: 'North-East', north: 45.0, west: 100.0, south: 20.0, east: 145.0 },
    // Zone 4: Indonesia, Australia
    { name: 'South', north: 0.0, west: 95.0, south: -25.0, east: 140.0 },
];

/**
 * Polls Flightradar24 using MULTI-ZONE scanning for maximum HKT coverage.
 */
async function pollRadarData() {
    try {
        console.log(`[${new Date().toISOString()}] Multi-zone scan starting...`);
        const now = new Date();
        
        // Step 1: Fetch flights from ALL zones and merge by flight ID
        const flightMap = new Map(); // id -> flight object (dedup)
        
        for (const zone of SCAN_ZONES) {
            try {
                const flights = await fetchFromRadar(zone.north, zone.west, zone.south, zone.east);
                let zoneHkt = 0;
                for (const f of flights) {
                    if (!flightMap.has(f.id)) {
                        flightMap.set(f.id, f);
                    }
                    if (f.destination && f.destination.toUpperCase() === 'HKT') zoneHkt++;
                    if (f.origin && f.origin.toUpperCase() === 'HKT') zoneHkt++;
                }
                console.log(`  📡 ${zone.name}: ${flights.length} flights (${zoneHkt} HKT)`);
                // Small delay between zone fetches
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                console.log(`  ⚠️ ${zone.name} failed: ${err.message}`);
            }
        }
        
        const allFlights = Array.from(flightMap.values());
        console.log(`  📊 Total unique flights: ${allFlights.length}`);
        
        // Step 3: Process flights of interest (Origin or Destination = HKT)
        const responseData = new Map();
        const seenArrivalIds = new Set(); // Track which arrival IDs we see in THIS poll
        
        for (const flight of allFlights) {
            const origin = (flight.origin || "").toUpperCase();
            const destination = (flight.destination || "").toUpperCase();
            
            // Only care about Phuket (HKT)
            if (origin !== "HKT" && destination !== "HKT") continue;
            
            // Early exit: If this flight instance already reported its final event (ATA/ATD), ignore it
            if (reportedLandedFlights.has(flight.id) || reportedDepartedFlights.has(flight.id)) continue;

            try {
                const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
                const iata = flight.flight || 'UNKNOWN';

                if (destination === "HKT") {
                    // --- ARRIVAL LOGIC ---
                    seenArrivalIds.add(flight.id);
                    const detail = await fetchFlight(flight.id);
                    const eta = detail.arrival || detail.scheduledArrival || null;
                    
                    // Track this flight for disappearance detection (reset missCount since we see it)
                    trackedArrivals.set(flight.id, { 
                        callsign, 
                        iata, 
                        lastETA: eta, 
                        lastAIBT: detail.arrival, // Store potential AIBT
                        missCount: 0 
                    });
                    
                    // Report ETA normally (still in air)
                    responseData.set(flight.id, { 
                        Callsign: callsign, 
                        IATA: iata, 
                        ETA: eta,
                        AOBT: detail.departure // Origin AOBT (for completeness)
                    });
                    
                } else if (origin === "HKT") {
                    // --- DEPARTURE LOGIC ---
                    if (!flight.isOnGround) {
                        // First time take-off detection
                        const detail = await fetchFlight(flight.id);
                        responseData.set(flight.id, { 
                            Callsign: callsign, 
                            IATA: iata, 
                            ATD: getHktTime(), // Use Current Server Time when wheels up
                            AOBT: detail.departure // Keep FR24 gate departure time as AOBT
                        });
                        reportedDepartedFlights.set(flight.id, Date.now());
                        console.log(`  🛫 ${callsign} (HKT Departure) TOOK OFF. Reporting ATD.`);
                    }
                }

                // Small delay between detailed fetches
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.log(`  ⚠️ Error processing ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Step 5: Detect landed flights (disappeared from radar)
        for (const [id, info] of trackedArrivals.entries()) {
            // Skip if we still see this flight in the current scan
            if (seenArrivalIds.has(id)) continue;
            // Skip if already reported
            if (reportedLandedFlights.has(id)) continue;
            
            // Flight not seen this poll — increment miss counter
            info.missCount = (info.missCount || 0) + 1;
            
            if (info.lastETA) {
                const etaTime = new Date(info.lastETA).getTime();
                const timeDiff = now.getTime() - etaTime;
                
                if (info.missCount >= MISS_THRESHOLD && timeDiff >= 0 && timeDiff < ATA_WINDOW_MS) {
                    // Missing for 3+ polls AND ETA has PASSED (within last 15 min) -> confirmed landing
                    responseData.set(id, { 
                        Callsign: info.callsign, 
                        IATA: info.iata, 
                        ATA: info.lastETA,
                        AIBT: info.lastAIBT || null // Use AIBT if we caught it in the last poll
                    });
                    reportedLandedFlights.set(id, Date.now());
                    trackedArrivals.delete(id);
                    console.log(`  🛬 ${info.callsign} confirmed landed. Reporting ATA.`);
                } else if (timeDiff >= ATA_WINDOW_MS) {
                    // ETA was long ago but we never caught it -> clean up
                    trackedArrivals.delete(id);
                    console.log(`  🗑️ ${info.callsign} expired from tracking (ETA too old).`);
                } else if (info.missCount < MISS_THRESHOLD) {
                    // Not enough misses yet, could be radar glitch
                    console.log(`  🔍 ${info.callsign} missing poll ${info.missCount}/${MISS_THRESHOLD}, waiting...`);
                }
                // If ETA is still far in the future -> radar glitch, keep tracking silently
            }
        }
        
        // Update global cache
        flightDataCache = Array.from(responseData.values());
        if (flightDataCache.length > 0) {
            lastFetchTime = now;
        }
        
        console.log(`  📋 Tracking ${trackedArrivals.size} arrivals`);
        console.log(`[${now.toISOString()}] ✅ Cache updated: ${flightDataCache.length} Phuket flights.\n`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error: ${error.message}`);
    }
}

// First fetch on startup
pollRadarData();

// Poll every 60 seconds
setInterval(pollRadarData, POLLING_INTERVAL);

// Cleanup reported flights every hour to prevent memory bloat
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [id, timestamp] of reportedLandedFlights.entries()) {
        if (now - timestamp > REPORT_EXPIRY) {
            reportedLandedFlights.delete(id);
            cleaned++;
        }
    }
    for (const [id, timestamp] of reportedDepartedFlights.entries()) {
        if (now - timestamp > REPORT_EXPIRY) {
            reportedDepartedFlights.delete(id);
            cleaned++;
        }
    }
    // Also clean stale tracked arrivals (older than 24 hours)
    for (const [id, info] of trackedArrivals.entries()) {
        if (info.lastETA) {
            const etaTime = new Date(info.lastETA).getTime();
            if (now - etaTime > REPORT_EXPIRY) {
                trackedArrivals.delete(id);
                cleaned++;
            }
        }
    }
    if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} expired flight records.`);
}, CLEANUP_INTERVAL);

// ===================================
// API Endpoints
// ===================================

app.get('/api/flights/eta', (req, res) => {
    res.json(flightDataCache);
});

app.get('/api/external/flights', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'hkt-apron-static-key') {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing x-api-key' });
    }
    res.json(flightDataCache);
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        cacheLength: flightDataCache.length,
        lastFetchTime: lastFetchTime
    });
});

app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`🛰️  HKT-Radar-Engine v3.7 — Takeoff ATD + AIBT/AOBT Support`);
    console.log(`📡 ${SCAN_ZONES.length} zones × 1500 = up to ${SCAN_ZONES.length * 1500} flights scanned`);
    console.log(`🌐 Port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}/api/flights/eta`);
    console.log(`=============================================\n`);
});
