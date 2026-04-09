const { fetchFromRadar } = require('flightradar24-client');

async function checkFields() {
    try {
        const flights = await fetchFromRadar(8.150, 98.250, 8.080, 98.350, null, { onGround: true });
        if (flights.length > 0) {
            console.log("Fields in flight object:", Object.keys(flights[0]));
            console.log("Sample Data:", JSON.stringify(flights[0], null, 2));
        } else {
            console.log("No flights found on ground now.");
        }
    } catch (e) {
        console.error(e);
    }
}

checkFields();
