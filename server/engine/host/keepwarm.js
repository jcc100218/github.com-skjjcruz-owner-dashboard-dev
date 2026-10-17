#!/usr/bin/env node
// Keeps the engine server from being counted as idle (owner ask 2026-10-17).
// Oracle stops an Always Free A1 server when, over 7 days, CPU, network AND
// memory all stay under 20%. The hourly build uses ~2% CPU, so this holds
// ~1.4 GB of the 6 GB (well over 20% with the system's own use) and does
// nothing else. Run by dhq-keepwarm.service at the lowest priority.
'use strict';
const { Buffer } = require('buffer');
const MB = Number(process.env.KEEPWARM_MB || 1400);
const CHUNK = 64 * 1024 * 1024;
const held = [];
for (let got = 0; got < MB * 1024 * 1024; got += CHUNK) held.push(Buffer.alloc(CHUNK, 1)); // filled, so the memory is really committed
console.log('holding ' + MB + ' MB');
// Touch one byte per page every 10 minutes so the memory stays resident.
setInterval(() => { for (const b of held) for (let i = 0; i < b.length; i += 4096) b[i] = (b[i] + 1) & 255; }, 10 * 60 * 1000);
