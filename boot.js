// Entry point: age GitHub theke data ferot ane (jodi local DB na thake), tarpor server chalay.
const path = require('path');
const dir = path.resolve(process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data'));
require('./backup').restore(path.join(dir, 'chatgram.sqlite')).catch(e => console.error('[backup]', e.message)).finally(() => require('./server.js'));

