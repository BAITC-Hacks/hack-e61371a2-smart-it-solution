import { readConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './server.js';
const config=readConfig();const pool=createPool(config.databaseUrl);
pool.on('error',()=>console.error(JSON.stringify({level:'error',code:'IDLE_DB_CONNECTION'})));
const server=createApp(pool,config);
server.listen(config.port,'0.0.0.0',()=>console.log(JSON.stringify({event:'server.started',port:config.port,demo:config.demo})));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
