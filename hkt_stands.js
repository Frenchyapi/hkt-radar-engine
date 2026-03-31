/**
 * HKT Aircraft Stand Coordinates (VTSP)
 * Data Source: AIP Thailand (VTSP AD 2.24-11 - 08 OCT 2020)
 * Format: WGS-84 Decimal Degrees
 */

const STANDS = [
    { nr: "1",   lat: 8.109833, lon: 98.308278, apron: "B" },
    { nr: "2",   lat: 8.109786, lon: 98.307797, apron: "B" },
    { nr: "3",   lat: 8.109739, lon: 98.307319, apron: "B" },
    { nr: "4",   lat: 8.109692, lon: 98.306839, apron: "B" },
    { nr: "5",   lat: 8.109644, lon: 98.306361, apron: "B" },
    { nr: "6",   lat: 8.109567, lon: 98.305828, apron: "B" },
    { nr: "7",   lat: 8.109025, lon: 98.305672, apron: "A" },
    { nr: "8",   lat: 8.108394, lon: 98.305511, apron: "A" },
    { nr: "9",   lat: 8.107764, lon: 98.305347, apron: "A" },
    { nr: "10",  lat: 8.107136, lon: 98.305186, apron: "A" },
    { nr: "11",  lat: 8.106503, lon: 98.305083, apron: "A" },
    { nr: "12L", lat: 8.106028, lon: 98.304603, apron: "A" },
    { nr: "12",  lat: 8.105786, lon: 98.304831, apron: "A" },
    { nr: "12R", lat: 8.105719, lon: 98.304742, apron: "A" },
    { nr: "14L", lat: 8.105344, lon: 98.304425, apron: "A" },
    { nr: "14",  lat: 8.105103, lon: 98.304653, apron: "A" },
    { nr: "14R", lat: 8.105036, lon: 98.304561, apron: "A" },
    { nr: "15",  lat: 8.104483, lon: 98.304508, apron: "A" },
    { nr: "16",  lat: 8.103964, lon: 98.304372, apron: "A" },
    { nr: "21",  lat: 8.111131, lon: 98.306667, apron: "C" },
    { nr: "22",  lat: 8.111139, lon: 98.306942, apron: "C" },
    { nr: "23",  lat: 8.111167, lon: 98.307211, apron: "C" },
    { nr: "24",  lat: 8.111192, lon: 98.307483, apron: "C" },
    { nr: "25",  lat: 8.111242, lon: 98.308025, apron: "C" },
    { nr: "26",  lat: 8.111269, lon: 98.308297, apron: "C" },
    { nr: "27",  lat: 8.111294, lon: 98.308569, apron: "C" },
    { nr: "28",  lat: 8.111317, lon: 98.308839, apron: "C" },
    { nr: "99",  lat: 8.110886, lon: 98.303461, apron: "C" },
    { nr: "31",  lat: 8.109886, lon: 98.302925, apron: "D" },
    { nr: "32L", lat: 8.109006, lon: 98.302769, apron: "D" },
    { nr: "32",  lat: 8.109200, lon: 98.302747, apron: "D" },
    { nr: "32R", lat: 8.109358, lon: 98.302864, apron: "D" },
    { nr: "33L", lat: 8.108297, lon: 98.302583, apron: "D" },
    { nr: "33",  lat: 8.108492, lon: 98.302558, apron: "D" },
    { nr: "33R", lat: 8.108650, lon: 98.302675, apron: "D" },
    { nr: "34L", lat: 8.107589, lon: 98.302397, apron: "D" },
    { nr: "34",  lat: 8.107783, lon: 98.302372, apron: "D" },
    { nr: "34R", lat: 8.107942, lon: 98.302489, apron: "D" },
    { nr: "35",  lat: 8.107208, lon: 98.302400, apron: "D" },
    { nr: "36",  lat: 8.106856, lon: 98.302308, apron: "D" },
    { nr: "37",  lat: 8.106419, lon: 98.302128, apron: "D" },
    { nr: "38",  lat: 8.105900, lon: 98.301992, apron: "D" },
    { nr: "39",  lat: 8.105381, lon: 98.301853, apron: "D" },
    { nr: "40",  lat: 8.104858, lon: 98.301717, apron: "D" }
];

/**
 * Calculates distance between two WGS-84 points in meters
 */
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Earth radius in meters
    const p1 = lat1 * Math.PI / 180;
    const p2 = lat2 * Math.PI / 180;
    const dp = (lat2 - lat1) * Math.PI / 180;
    const dl = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
              Math.cos(p1) * Math.cos(p2) *
              Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
}

/**
 * Returns the nearest stand info for a given coordinate
 */
function getStandInfo(lat, lon) {
    let nearest = null;
    let minDistance = Infinity;

    for (const stand of STANDS) {
        const d = getDistance(lat, lon, stand.lat, stand.lon);
        if (d < minDistance) {
            minDistance = d;
            nearest = stand;
        }
    }

    return {
        stand: nearest ? nearest.nr : "UNKNOWN",
        apron: nearest ? nearest.apron : "UNKNOWN",
        distance: minDistance
    };
}

module.exports = {
    STANDS,
    getStandInfo
};
