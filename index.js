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
        
        // Step 2: Filter flights with destination HKT or origin HKT
        const hktArrivals = allFlights.filter(f => 
            f.destination && f.destination.toUpperCase() === 'HKT'
        );
        const hktDepartures = allFlights.filter(f => 
            f.origin && f.origin.toUpperCase() === 'HKT'
        );
        
        console.log(`  ✈️ HKT-bound: ${hktArrivals.length} | HKT-departing: ${hktDepartures.length}`);
        
        if (hktArrivals.length === 0 && hktDepartures.length === 0) {
            flightDataCache = [];
            lastFetchTime = now;
            return;
        }
        
        // Step 3: Fetch REAL FR24 ETA/ATA for each HKT arrival
        const responseData = new Map(); // Using Map to ensure each ID is unique in the response
        
        for (const flight of hktArrivals) {
            // Early exit: If already reported as landed or departed, skip entirely
            if (reportedLandedFlights.has(flight.id) || reportedDepartedFlights.has(flight.id)) continue;
            
            try {
                const detail = await fetchFlight(flight.id);
                const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
                
                // ATA Logic: If flight is on ground, it has landed at HKT
                if (flight.isOnGround) {
                    // One last check just in case it was added to reported during this scan (unlikely but safe)
                    if (!reportedLandedFlights.has(flight.id)) {
                        // First time reporting this landing
                        responseData.set(flight.id, {
                            Callsign: typeof callsign === 'string' ? callsign.trim() : 'UNKNOWN',
                            IATA: flight.flight || 'UNKNOWN',
                            ATA: detail.arrival
                        });
                        reportedLandedFlights.set(flight.id, Date.now());
                        console.log(`  🛬 ${callsign} LANDED. Reporting ATA.`);
                    }
                } else {
                    // Flight is still in the air, report ETA
                    const eta = detail.arrival || detail.scheduledArrival || null;
                    responseData.set(flight.id, {
                        Callsign: typeof callsign === 'string' ? callsign.trim() : 'UNKNOWN',
                        IATA: flight.flight || 'UNKNOWN',
                        ETA: eta
                    });
                }
                
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.log(`  ⚠️ Detail failed for ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Step 4: Fetch ATD for each HKT departure
        for (const flight of hktDepartures) {
            // Early exit: If already reported, skip entirely
            if (reportedLandedFlights.has(flight.id) || reportedDepartedFlights.has(flight.id)) continue;

            try {
                const callsign = flight.callsign || flight.flight || flight.registration || 'UNKNOWN';
                
                // ATD Logic: If flight has taken off (not on ground) and origin is HKT
                if (!flight.isOnGround) {
                    if (!reportedDepartedFlights.has(flight.id)) {
                        const detail = await fetchFlight(flight.id);
                        // First time reporting this departure
                        responseData.set(flight.id, {
                            Callsign: typeof callsign === 'string' ? callsign.trim() : 'UNKNOWN',
                            IATA: flight.flight || 'UNKNOWN',
                            ATD: detail.departure
                        });
                        reportedDepartedFlights.set(flight.id, Date.now());
                        console.log(`  🛫 ${callsign} DEPARTED HKT. Reporting ATD.`);
                    }
                }
                // If still on ground at HKT (not departed yet), we don't report anything (not in ETA list)
                
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.log(`  ⚠️ Detail failed for ${flight.callsign || flight.id}: ${err.message}`);
            }
        }
        
        // Update cache from response map
        flightDataCache = Array.from(responseData.values());
        if (flightDataCache.length > 0) {
            lastFetchTime = now;
        }
        
        console.log(`[${now.toISOString()}] ✅ Cache updated: ${flightDataCache.length} HKT flights.\n`);

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
    console.log(`🛰️  HKT-Radar-Engine v3.3 — Multi-Zone Scan + ATA/ATD (Fixed Dups)`);
    console.log(`📡 ${SCAN_ZONES.length} zones × 1500 = up to ${SCAN_ZONES.length * 1500} flights scanned`);
    console.log(`🌐 Port ${PORT}`);
    console.log(`👉 http://localhost:${PORT}/api/flights/eta`);
    console.log(`=============================================\n`);
});
