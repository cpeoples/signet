/**
 * First-party hardware facts from the firmware the checker already reads: the DeviceTree
 * (product node, CPU nodes, GPU node) and the BuildManifest identity (chip IDs, components).
 * Only what Apple's files actually state; nothing is inferred from tables.
 */
import { cstr, type DtNode } from "./devicetree.js";

export interface FirmwareSpecs {
  soc: {
    chip_id: string | null;
    /** Apple platform name from the GPU node, e.g. "t8140". Not a marketing name ("A18 Pro"). */
    platform: string | null;
    cpu_cores: number | null;
    performance_cores: number | null;
    efficiency_cores: number | null;
    architecture: string | null;
    /** Metal GPU family the OS targets, e.g. "APPLE9" (tvOS uses "MTL5,1"-style values). */
    metal_family: string | null;
    /** Apple's performance memory class. Correlates with RAM but is NOT RAM in GB. */
    memory_class: number | null;
  };
  display: { gamut: string | null; scale: number | null; oled: boolean };
  radios: { cellular: boolean; baseband_chip_id: string | null; esim: boolean; wifi_chipset: string | null };
  microphones: number | null;
  /** Capability flags the DeviceTree declares. Absence means "not declared", not "unsupported". */
  features: string[];
  /** ProductType Apple falls back to for compatibility (usually the predecessor model). */
  predecessor: string | null;
}

const printable = (b?: Buffer) => { const s = cstr(b); return s && s.length > 1 && /^[\x20-\x7e]+$/.test(s) ? s : undefined; };
const u32 = (b?: Buffer) => (b && b.length >= 4 ? b.readUInt32LE(0) : undefined);
/** DeviceTree booleans: an empty property or a non-zero integer. */
const isTrue = (b?: Buffer) => !!b && (b.length === 0 || (b.length >= 4 ? b.readUInt32LE(0) !== 0 : b[0] !== 0));

// DeviceTree product flag -> report name (only reported when the flag is set).
const FEATURES: Record<string, string> = {
  "nfc-express": "nfc",
  "gps-capable": "gps",
  "find-my": "find_my",
  "supports-camera-button": "camera_control",
  "carplay-2": "carplay",
  "has-virtualization": "virtualization",
  "has-exclaves": "exclaves",
  "supports-recoveryos": "recovery_os",
  "bluetooth-le": "bluetooth_le",
  "personal-hotspot": "personal_hotspot",
  "supports-burnin-mitigation": "burn_in_mitigation",
  "low-power-express": "express_mode_power_reserve",
};

export function firmwareSpecs(nodes: DtNode[], identity: Record<string, any> | undefined): FirmwareSpecs {
  const at = (p: string) => nodes.find((n) => n.path === p)?.props ?? {};
  const prod = at("/device-tree/product");
  const cpus = nodes.filter((n) => /^\/device-tree\/cpus\/cpu\d+$/.test(n.path)).map((n) => cstr(n.props["cluster-type"]));
  const typed = cpus.length > 0 && cpus.every(Boolean);
  const gpu = nodes.find((n) => /\/arm-io\/sgx$/.test(n.path))?.props;
  const components = Object.keys(identity?.Manifest ?? {});
  const has = (c: string) => components.some((k) => k === c || k.startsWith(c + ","));

  return {
    soc: {
      chip_id: identity?.ApChipID ?? null,
      platform: cstr(gpu?.["compatible"])?.split(",")[1] ?? null,
      cpu_cores: cpus.length || null,
      performance_cores: typed ? cpus.filter((c) => c === "P").length : null,
      efficiency_cores: typed ? cpus.filter((c) => c === "E").length : null,
      architecture: printable(prod["app-macho-architecture"]) ?? null,
      metal_family: printable(prod["graphics-featureset-class"]) ?? null,
      memory_class: u32(prod["device-perf-memory-class"]) ?? null,
    },
    display: {
      gamut: printable(prod["artwork-display-gamut"]) ?? null,
      scale: u32(prod["artwork-scale-factor"]) || null,
      oled: isTrue(prod["oled-display"]),
    },
    radios: {
      cellular: has("BasebandFirmware"),
      baseband_chip_id: identity?.BbChipID ?? null,
      esim: has("eUICC"),
      wifi_chipset: printable(prod["wifi-chipset"]) ?? null,
    },
    microphones: u32(prod["builtin-mics"]) ?? null,
    features: [
      ...Object.entries(FEATURES).filter(([k]) => isTrue(prod[k])).map(([, v]) => v),
      ...(u32(prod["island-notch-location"]) ? ["dynamic_island"] : []),
    ].sort(),
    predecessor: printable(prod["compatible-device-fallback"]) ?? null,
  };
}
