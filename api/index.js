const express = require('express');
const { Readable, Transform } = require('stream');
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
 * M3U BIZTONSÁGI PAJZS (Stream Transformer)
 * Menet közben átírja a szolgáltatói linkeket és jelszavakat a sajátunkra
 */
class M3uTransformer extends Transform {
    constructor(host, myUser, myPass, iptvUrl, iptvUser, iptvPass) {
        super();
        this.tail = '';
        try {
            this.providerHost = new URL(iptvUrl).host;
        } catch(e) {
            this.providerHost = iptvUrl.replace(/^https?:\/\//, '').split('/')[0];
        }
        this.proxyHost = host; 
        this.myUser = myUser;
        this.myPass = myPass;
        this.iptvUser = iptvUser;
        this.iptvPass = iptvPass;
    }

    _transform(chunk, encoding, callback) {
        let text = this.tail + chunk.toString('utf8');
        
        // 1. Host csere (pl. domain.com -> proxy.vercel.app)
        text = text.split(this.providerHost).join(this.proxyHost);
        // 2. Jelszó/User csere az EPG URL-ekhez
        text = text.split(`username=${this.iptvUser}`).join(`username=${this.myUser}`);
        text = text.split(`password=${this.iptvPass}`).join(`password=${this.myPass}`);
        // 3. Stream path csere (/live/eredeti_user/eredeti_pass/ -> /live/fake_user/fake_pass/)
        text = text.split(`/${this.iptvUser}/${this.iptvPass}/`).join(`/${this.myUser}/${this.myPass}/`);

        const lastNewline = text.lastIndexOf('\n');
        if (lastNewline !== -1) {
            this.push(text.slice(0, lastNewline + 1));
            this.tail = text.slice(lastNewline + 1);
        } else {
            this.tail = text;
        }
        callback();
    }

    _flush(callback) {
        if (this.tail) this.push(this.tail);
        callback();
    }
}

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
    
    // CORS (Webes lejátszók támogatásához)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
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

        // HA BEJELENTKEZÉS (Nincs action paraméter, csak a server_info lekérése)
        if (!action && contentType && contentType.includes('application/json')) {
            let rawText = await response.text();
            try {
                let data = JSON.parse(rawText);
                
                // USER_INFO módosítása (Smarters Pro ezt nézi először)
                if (data.user_info) {
                    data.user_info.username = MY_USER;
                    data.user_info.password = MY_PASS;
                    data.user_info.auth = 1;
                    data.user_info.status = "Active";
                    data.user_info.exp_date = "2145225600"; // Távoli lejárat (2037.12.24)
                }

                // SERVER_INFO módosítása (Hogy a TV a mi proxynkat hívja tovább)
                if (data.server_info) {
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
        
        // MINDEN MÁS ESETBEN (EPG XML, M3U, vagy egyéb JSON kérések pl. action=get_live_streams)
        // Közvetlenül streameljük a választ a TV-nek, így nem fogy el a Vercel memóriája és nem kapunk Timeout hibát.
        const headersToForward = ['content-type', 'content-disposition'];
        headersToForward.forEach(h => {
            if (response.headers.has(h)) {
                res.setHeader(h, response.headers.get(h));
            }
        });

        if (response.body) {
            const reader = Readable.fromWeb(response.body);
            
            // Ellenőrizzük, hogy ez egy M3U lista kérés-e
            const isM3u = (contentType && (contentType.includes('mpegurl') || contentType.includes('octet-stream'))) && 
                          (req.query.type === 'm3u' || req.path.includes('m3u') || req.path.includes('get.php'));
            
            if (isM3u) {
                // Biztonságosan átírjuk az adatokat menet közben!
                const host = req.headers.host;
                const m3uTransformer = new M3uTransformer(host, MY_USER, MY_PASS, IPTV_URL, IPTV_USER, IPTV_PASS);
                reader.pipe(m3uTransformer).pipe(res);
            } else {
                // Egyéb fájlokat (pl. EPG XML) simán átengedünk
                reader.pipe(res);
            }
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
