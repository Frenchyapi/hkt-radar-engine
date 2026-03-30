const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// In-memory Cache & State
let flightDataCache = [];
let lastFetchTime = null;
const reportedLandedFlights = new Map(); // Store flight IDs that have already reported ATA
const reportedDepartedFlights = new Map(); // Store flight IDs that have already reported ATD
const POLLING_INTERVAL = 60 * 1000; // 60 seconds
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const REPORT_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

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
                const onGround = flight.isOnGround;

                if (destination === "HKT") {
                    // --- ARRIVAL LOGIC ---
                    const detail = await fetchFlight(flight.id);
                    if (onGround) {
                        // First time landing detection
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATA: detail.arrival });
                        reportedLandedFlights.set(flight.id, Date.now());
                        console.log(`  🛬 ${callsign} (HKT Arrival) LANDED. Reporting ATA.`);
                    } else {
                        // Still in air, reporting ETA normally
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ETA: detail.arrival || detail.scheduledArrival });
                    }
                } else if (origin === "HKT") {
                    // --- DEPARTURE LOGIC ---
                    if (!onGround) {
                        // First time take-off detection (we only report once it's in the air)
                        const detail = await fetchFlight(flight.id);
                        responseData.set(flight.id, { Callsign: callsign, IATA: iata, ATD: detail.departure });
                        reportedDepartedFlights.set(flight.id, Date.now());
                        console.log(`  🛫 ${callsign} (HKT Departure) TOOK OFF. Reporting ATD.`);
                    }
                    // If still on ground at HKT, we don't add to responseData (silent until departure)
                }

                // Small delay between detailed fetches
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.log(`  ⚠️ Error processing ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Update global cache
        flightDataCache = Array.from(responseData.values());
        if (flightDataCache.length > 0) {
            lastFetchTime = now;
        }
        
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
    if (cleaned > 0) console.log(`[CLEANUP] Removed ${cleaned} expired flight reports.`);
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
    console.log(`🛰️  HKT-Radar-Engine v3.4 — Unified Phuket Loop + ATA/ATD Single-Shot`);
    console.log(`📡 ${SCAN_ZONES.length} zones × 1500 = up to ${SCAN_ZONES.length * 1500} flights scanned`);
    console.log(`🌐 Port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}/api/flights/eta`);
    console.log(`=============================================\n`);
});
