/**
 * Makes mineflayer talk to a Minecraft 26.2 (protocol 776) server.
 *
 * Two separate things block this out of the box:
 *
 *  1. minecraft-data 3.113.2 lists 26.2 in protocolVersions.json but ships no
 *     data/pc/26.2 directory, so `mcData('26.2')` returns null and mineflayer
 *     dies with "No data available for version 26.2". We alias 26.2 onto the
 *     26.1 (protocol 775) data set while still reporting 776.
 *
 *  2. mineflayer's own guard (lib/version.js) stops at 1.21.11, so it rejects
 *     anything newer with "Server version '26.2' is not supported". We raise
 *     that ceiling.
 *
 * This is a stopgap. It assumes the 775 -> 776 wire format is compatible for
 * the packets this bot uses (handshake, login, keep-alive, position, look,
 * swing arm). Delete this file once mineflayer and minecraft-data ship real
 * 26.2 support.
 *
 * IMPORTANT: must be required *before* mineflayer is required, because
 * mineflayer's loader destructures its version ceiling at module load time.
 */

const ALIAS_VERSION = '26.2';
const ALIAS_PROTOCOL = 776;
const BASE_VERSION = '26.1';

function patchMinecraftData() {
  const data = require('minecraft-data/data.js');

  if (data.pc[ALIAS_VERSION]) {
    return { applied: false, reason: 'real 26.2 data is present' };
  }

  const base = data.pc[BASE_VERSION];
  if (!base) {
    return { applied: false, reason: `base version ${BASE_VERSION} is missing` };
  }

  // Copy 26.1's lazy getters verbatim so the JSON files are still loaded on
  // demand rather than eagerly.
  const entry = Object.defineProperties(
    {},
    Object.getOwnPropertyDescriptors(base)
  );

  // Report protocol 776 so the handshake announces what the server wants, but
  // keep majorVersion at 26.1. Downstream prismarine packages (notably
  // prismarine-chunk) look implementations up by majorVersion and already know
  // 26.1, so this makes them resolve without needing to patch each one.
  Object.defineProperty(entry, 'version', {
    get() {
      return {
        version: ALIAS_PROTOCOL,
        minecraftVersion: ALIAS_VERSION,
        majorVersion: BASE_VERSION,
        releaseType: 'release',
      };
    },
    enumerable: true,
    configurable: true,
  });

  data.pc[ALIAS_VERSION] = entry;

  return { applied: true, reason: `aliased ${ALIAS_VERSION} -> ${BASE_VERSION}` };
}

function patchMineflayerCeiling() {
  let versionModulePath;
  try {
    versionModulePath = require.resolve('mineflayer/lib/version.js');
  } catch (err) {
    return { applied: false, reason: 'mineflayer/lib/version.js not resolvable' };
  }

  const versionModule = require(versionModulePath);

  if (versionModule.latestSupportedVersion === ALIAS_VERSION) {
    return { applied: false, reason: 'ceiling already raised' };
  }

  // testedVersions must stay ordered oldest -> newest; loader.js derives the
  // protocol number from latestSupportedVersion via minecraft-data.
  if (!versionModule.testedVersions.includes(BASE_VERSION)) {
    versionModule.testedVersions.push(BASE_VERSION);
  }
  if (!versionModule.testedVersions.includes(ALIAS_VERSION)) {
    versionModule.testedVersions.push(ALIAS_VERSION);
  }
  versionModule.latestSupportedVersion = ALIAS_VERSION;

  return { applied: true, reason: `raised mineflayer ceiling to ${ALIAS_VERSION}` };
}

function applyShim() {
  const mcData = patchMinecraftData();
  const mineflayer = patchMineflayerCeiling();
  return { mcData, mineflayer };
}

module.exports = applyShim;
