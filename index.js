const express = require('express');
const cors = require('cors');
const { fetchFromRadar, fetchFlight } = require('flightradar24-client');

const app = express();
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors());
app.use(express.json());

// In-memory Cache
let flightDataCache = [];
let lastFetchTime = null;
const POLLING_INTERVAL = 60 * 1000; // 60 seconds

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
        
        // Step 2: Filter only flights with destination HKT
        const hktFlights = allFlights.filter(f => 
            f.destination && f.destination.toUpperCase() === 'HKT'
        );
        
        console.log(`  ✈️ HKT-bound: ${hktFlights.length}`);
        
        if (hktFlights.length === 0) {
            flightDataCache = [];
            lastFetchTime = now;
            return;
        }
        
        // Step 3: Fetch REAL FR24 ETA for each HKT flight
        const detailedFlights = [];
        
        for (const flight of hktFlights) {
            try {
                const detail = await fetchFlight(flight.id);
                const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
                const eta = detail.arrival || detail.scheduledArrival || null;
                
                detailedFlights.push({
                    Callsign: typeof callsign === 'string' ? callsign.trim() : 'UNKNOWN',
                    ETA: eta
                });
                
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.log(`  ⚠️ Detail failed for ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Update cache
        flightDataCache = detailedFlights;
        if (detailedFlights.length > 0) {
            lastFetchTime = now;
        }
        
        console.log(`[${now.toISOString()}] ✅ Cache updated: ${detailedFlights.length} HKT flights with FR24 ETA.\n`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error: ${error.message}`);
    }
}

// First fetch on startup
pollRadarData();

// Poll every 60 seconds
setInterval(pollRadarData, POLLING_INTERVAL);

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
    console.log(`🛰️  HKT-Radar-Engine v3.0 — Multi-Zone Scan`);
    console.log(`📡 ${SCAN_ZONES.length} zones × 1500 = up to ${SCAN_ZONES.length * 1500} flights scanned`);
    console.log(`🌐 Port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}/api/flights/eta`);
    console.log(`=============================================\n`);
});
