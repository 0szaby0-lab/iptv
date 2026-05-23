const express = require('express');
const { Readable } = require('stream');
const app = express();

/**
 * KONFIGURÁCIÓ
 * Ezeket a Vercel Environment Variables-nél kell megadnod!
 */
let IPTV_URL = process.env.IPTV_URL ? process.env.IPTV_URL.replace(/\/+$/, "") : ""; 
const IPTV_USER = process.env.IPTV_USER;
const IPTV_PASS = process.env.IPTV_PASS;

const MY_USER = process.env.MY_USER;
const MY_PASS = process.env.MY_PASS;

// Ez a timestamp minden egyes Vercel indításkor (Redeploy) frissül.
// Ez jelzi az IPTV Smartersnek, hogy új adatok érkeztek.
const SERVER_BOOT_TIME = Math.floor(Date.now() / 1000);

/**
 * HITELÉSÍTÉS ELLENŐRZÉSE
 */
function checkCredentials(user, pass) {
    if (!MY_USER || !MY_PASS) return false;
    return user === MY_USER && pass === MY_PASS;
}

/**
 * GLOBÁLIS CACHE TILTÁS
 * Megakadályozza, hogy a TV vagy a Vercel elmentse a régi listát.
 */
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    next();
});

/**
 * FŐOLDAL (Teszteléshez)
 */
app.get('/', (req, res) => {
    res.status(200).send(`
        <h1>Proxy Aktív 🚀</h1>
        <p>Állapot: Fut</p>
        <p>Utolsó frissítés: ${new Date(SERVER_BOOT_TIME * 1000).toLocaleString('hu-HU')}</p>
    `);
});

/**
 * API HÍVÁSOK (Panel adatok, EPG, Csatornalista)
 */
app.get(['/player_api.php', '/xmltv.php', '/epg.php', '/get.php', '/m3u.php'], async (req, res) => {
    const { username, password, action } = req.query;

    // Ellenőrizzük a belépési adatokat (amit te adtál meg a TV-ben)
    if (!checkCredentials(username, password)) {
        console.error(`Hiba: Illetéktelen hozzáférés: ${username}`);
        return res.status(401).json({ error: "Hibás hitelesítés!" });
    }

    try {
        // Paraméterek összeállítása a valódi szolgáltató felé
        const urlParams = new URLSearchParams(req.query);
        urlParams.set('username', IPTV_USER);
        urlParams.set('password', IPTV_PASS);
        
        const targetUrl = `${IPTV_URL}${req.path}?${urlParams.toString()}`;
        
        const fetchHeaders = { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Connection': 'keep-alive'
        };
        
        const response = await fetch(targetUrl, { headers: fetchHeaders });
        
        if (response.redirected) {
             return res.redirect(302, response.url);
        }

        const contentType = response.headers.get('content-type');

        // HA JSON VÁLASZ (Ez jön a player_api.php-ra)
        if (contentType && contentType.includes('application/json')) {
            let rawText = await response.text();
            try {
                let data = JSON.parse(rawText);
                
                // USER_INFO módosítása (Smarters Pro ezt nézi először)
                if (data.user_info) {
                    data.user_info.username = MY_USER;
                    data.user_info.password = MY_PASS;
                    data.user_info.auth = 1;
                    data.user_info.status = "Active";
                    data.user_info.exp_date = "1012608000"; // Távoli lejárat (2002)
                }

                // SERVER_INFO módosítása (Hogy a TV a mi proxynkat hívja tovább)
                if (data.server_info && !action) {
                    const host = req.headers.host;
                    data.server_info.url = host;
                    data.server_info.port = "443";
                    data.server_info.https_port = "443";
                    data.server_info.server_protocol = "https";
                    
                    // Frissített időbélyeg küldése
                    data.server_info.timestamp = SERVER_BOOT_TIME;
                    
                    // Opcionális: Üzenet küldése a Smarters Pro fejlécébe
                    data.server_info.message = "Rendszer frissítve: " + new Date(SERVER_BOOT_TIME * 1000).toLocaleTimeString('hu-HU');
                }

                return res.json(data);
            } catch (err) {
                return res.send(rawText);
            }
        } 
        
        // HA NEM JSON (EPG XML vagy M3U lista)
        res.setHeader('Content-Type', contentType || 'text/plain');
        if (response.body) {
            const reader = Readable.fromWeb(response.body);
            reader.pipe(res);
        } else {
            res.status(204).send();
        }

    } catch (error) {
        console.error('Hiba a kérés feldolgozásakor:', error.message);
        res.status(500).send('Szerver hiba történt.');
    }
});

/**
 * ÉLŐ ADÁS ÉS FILMEK ÁTIRÁNYÍTÁSA (Streams)
 * Példa: /live/sajatuser/sajatpass/1234.ts
 */
app.get('/:type/:user/:pass/:filename', (req, res) => {
    const { type, user, pass, filename } = req.params;

    if (!checkCredentials(user, pass)) {
        return res.status(403).send('Hozzáférés megtagadva!');
    }

    // A valódi stream URL összeállítása
    const finalStreamUrl = `${IPTV_URL}/${type}/${IPTV_USER}/${IPTV_PASS}/${filename}`;
    
    // Átirányítás (302), így a videó adatfolyam nem terheli a Vercel-t
    // De amint az IPTV_URL változik, a régi stream megáll.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.redirect(302, finalStreamUrl);
});

// Vercel export
module.exports = app;
