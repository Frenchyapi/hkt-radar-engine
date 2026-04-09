const { fetchFromRadar } = require('flightradar24-client');

async function test() {
    const zone = { name: 'HKT-Full-Ground', north: 8.125, west: 98.295, south: 8.090, east: 98.345, options: { onGround: true, inactive: true } };
    try {
        console.log("Fetching HKT Ground traffic...");
        const flights = await fetchFromRadar(zone.north, zone.west, zone.south, zone.east, null, zone.options);
        console.log(`Found ${flights.length} flights on ground.`);
        flights.forEach(f => {
            console.log(`- ${f.callsign || f.flight || 'N/A'} (ID: ${f.id}, Spd: ${f.speed}, Lat: ${f.latitude}, Lon: ${f.longitude})`);
        });
    } catch (e) {
        console.error("API Error:", e.message);
    }
}

test();
