import { discover } from '../lib/discover.js';

const srv = {
  name: 'staging',
  host: '119.29.10.202',
  port: 22,
  user: 'root',
  keyPath: process.env.USERPROFILE + '/.ssh/toogel_vault',
};

const r = await discover(srv);
console.log(JSON.stringify(r, null, 2));
