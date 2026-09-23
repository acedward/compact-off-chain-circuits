// SPDX-License-Identifier: Apache-2.0
// Runs once before the suite. Most of what this repository claims can only be
// checked against real compiled artifacts, so say plainly what is missing rather
// than letting tests skip silently.
import { BUILD_HINT, COMPACT, COMPACT_HINT, REGISTRY_BUILD_HINT, hasCompact, isBuilt, isRegistryBuilt } from './helpers.mjs';

export default function setup() {
  const built = isBuilt();
  const compiler = hasCompact();
  console.log(`[prerequisites] build/            : ${built ? 'present' : `MISSING — ${BUILD_HINT}`}`);
  console.log(`[prerequisites] '${COMPACT}' CLI  : ${compiler ? 'present' : `MISSING — ${COMPACT_HINT}`}`);
  if (built && !isRegistryBuilt()) console.log(`[prerequisites] registry examples: MISSING — ${REGISTRY_BUILD_HINT}; the registry key, discovery and verify --standard tests will be SKIPPED.`);
  if (!built) console.log('[prerequisites] key identity, simulation, tampering, layout, witness, size and Level 3 tests will be SKIPPED.');
  else if (!compiler) console.log('[prerequisites] isolation, layout, witness and Level 3 tests will be SKIPPED.');
}
