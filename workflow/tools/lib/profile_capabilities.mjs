const RADAR_DENIAL = "radar_no_writeback";

export function capabilitiesForProfile(profile = "standard") {
  const normalized = String(profile || "standard").trim().toLowerCase();
  if (normalized === "radar") {
    return Object.freeze({ profile: normalized, zoteroRead: false, zoteroWrite: false, xlsxWrite: false, denialReason: RADAR_DENIAL });
  }
  return Object.freeze({ profile: normalized, zoteroRead: true, zoteroWrite: true, xlsxWrite: true, denialReason: "" });
}

export function assertProfileCapability(profile, capability) {
  const capabilities = capabilitiesForProfile(profile);
  if (capabilities[capability] !== true) throw new Error(`PROFILE_CAPABILITY_DENIED:${capabilities.denialReason}:${capability}`);
  return true;
}

export function runtimeProfile(env = process.env) {
  return String(env.PAPERECHO_RUN_PROFILE || "standard").trim().toLowerCase() || "standard";
}
