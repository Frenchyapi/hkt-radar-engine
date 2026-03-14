const express = require('express');
const cors = require('cors');
const { fetchFromRadar } = require('flightradar24-client');

const app = express();
// Default to port 3001 as your frontend is likely running on 3000
const PORT = process.env.PORT || 3001;

// Middlewares
app.use(cors()); // Allow cross-origin requests from your frontend
app.use(express.json());

// VTSP Coordinates (Phuket International Airport)
const VTSP_LAT = 8.1132;
const VTSP_LON = 98.3169;

// In-memory Cache setup
let flightDataCache = [];
let lastFetchTime = null;
const POLLING_INTERVAL = 30 * 1000; // 30 seconds

/**
 * Calculates the great-circle distance between two points on the Earth's surface
 * using the Haversine formula.
 * @param {number} lat1 - Latitude of point 1
 * @param {number} lon1 - Longitude of point 1
 * @param {number} lat2 - Latitude of point 2
 * @param {number} lon2 - Longitude of point 2
 * @returns {number} Distance in meters
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth's radius in meters
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
}

/**
 * Polls Flightradar24 for ADS-B data and processes calculations.
 */
async function pollRadarData() {
    try {
        console.log(`[${new Date().toISOString()}] Fetching data from Flightradar24-client...`);
        const now = new Date();
        
        // Exact API Signature: fetchFromRadar(north, west, south, east)
        // Set to a ~4 hour flight radius around Phuket (cruising speed ~800-900 km/h)
        // Limits must be kept so we don't hit the 1500 plane hard cap of the free API
        const flights = await fetchFromRadar(30.0, 70.0, -15.0, 120.0);
        
        if (!flights || flights.length === 0) {
            console.log(`[${now.toISOString()}] No aircraft found in the bounding box.`);
            flightDataCache = [];
            lastFetchTime = now;
            return;
        }

        const processedFlights = flights.map(flight => {
            // flightradar24-client maps data into a cleaner object for us natively:
            // { id, callsign, registration, latitude, longitude, speed(knots), altitude(feet), bearing, isOnGround, ... }
            
            const rawCallsign = flight.callsign || flight.flight || flight.registration;
            const callsign = typeof rawCallsign === 'string' && rawCallsign.trim() !== '' ? rawCallsign.trim() : 'UNKNOWN';
            
            const latitude = flight.latitude;
            const longitude = flight.longitude;
            
            if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) return null;

            const altitudeMeters = (flight.altitude || 0) * 0.3048; // Convert feet to meters
            const on_ground = flight.isOnGround === true || altitudeMeters <= 50;
            const velocityMPS = (flight.speed || 0) * 0.514444; // Convert knots to meters/second
            
            // Calculate distance to VTSP
            const distanceMeters = calculateHaversineDistance(latitude, longitude, VTSP_LAT, VTSP_LON);
            
            let status = 'EN ROUTE';
            let eta = null;
            let ata = null;

            // Determine ETA based on current velocity and distance to VTSP
            if (distanceMeters < 3000 && (altitudeMeters < 100 || on_ground)) {
                status = 'LANDED';
                // Create ATA Date and convert to GMT+7 ISO string
                const ataDate = now;
                ata = new Date(ataDate.getTime() + (7 * 60 * 60 * 1000)).toISOString().replace('Z', '+07:00');
            } else {
                if (velocityMPS > 0) {
                    const remainingTimeSeconds = distanceMeters / velocityMPS;
                    const etaDate = new Date(now.getTime() + (remainingTimeSeconds * 1000));
                    // Convert to GMT+7
                    eta = new Date(etaDate.getTime() + (7 * 60 * 60 * 1000)).toISOString().replace('Z', '+07:00');
                } else {
                    status = 'STATIONARY / HOLDING';
                }
            }

            return {
                Callsign: callsign,
                ETA: eta,
                ATA: ata,
                Status: status,
                // Extra metadata
                _DistanceMeters: Math.round(distanceMeters),
                _AltitudeMeters: Math.round(altitudeMeters),
                _VelocityMPS: Math.round(velocityMPS * 100) / 100
            };
        }).filter(f => f !== null);

        // Post-processing filter: Only keep flights with an ETA of <= 4 hours (14,400 seconds) 
        // or flights that have already landed
        const maxEtaSeconds = 4 * 60 * 60; 
        const filteredFlights = processedFlights.filter(flight => {
            if (flight.Status === 'LANDED') return true;
            if (flight.Status === 'STATIONARY / HOLDING') return false; // Filter out ground traffic far away

            if (flight.ETA) {
                const etaTime = new Date(flight.ETA.replace('+07:00', 'Z')).getTime() - (7 * 60 * 60 * 1000); // revert to UTC for math
                const secondsUntilEta = (etaTime - now.getTime()) / 1000;
                return secondsUntilEta <= maxEtaSeconds;
            }
            return false;
        });

        // Update in-memory cache
        flightDataCache = filteredFlights;
        if (filteredFlights.length > 0) {
            lastFetchTime = now;
        }
        
        console.log(`[${now.toISOString()}] Cache updated. Tracking ${filteredFlights.length} aircraft (<= 4 hours ETA).`);

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error fetching from Flightradar24: ${error.message}`);
    }
}

// Ensure the first fetch triggers immediately on startup
pollRadarData();

// Start polling sequence every 30 seconds
setInterval(pollRadarData, POLLING_INTERVAL);

// ===================================
// API Endpoints
// ===================================

app.get('/api/flights/eta', (req, res) => {
    // Requirements stated: returns a clean JSON array with ONLY Callsign and ETA
    const slimData = flightDataCache.map(f => ({
        Callsign: f.Callsign,
        ETA: f.ETA
    }));
    res.json(slimData);
});

app.get('/api/external/flights', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== 'hkt-apron-static-key') {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing x-api-key' });
    }
    // External API also returns ONLY Callsign and ETA
    const slimData = flightDataCache.map(f => ({
        Callsign: f.Callsign,
        ETA: f.ETA
    }));
    res.json(slimData);
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
    console.log(`🛰️  HKT-Radar-Engine Microservice Started! `);
    console.log(`📡 Polling Flightradar24-client API every 30 seconds`);
    console.log(`🌐 Server running locally on port ${PORT}`);
    console.log(`👉 Endpoint: http://localhost:${PORT}/api/flights/eta`);
    console.log(`=============================================\n`);
});
