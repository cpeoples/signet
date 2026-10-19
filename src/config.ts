/**
 * Endpoints and tunables. Defaults below; override any subset in signet.config.json
 * (looked up in the current directory) or a file passed with --config.
 */
import { existsSync, readFileSync } from "node:fs";
import { errorMessage } from "./util.js";

export interface Config {
  /** IPSW sources: feed name -> plist URL. Each name is usable with --feed. */
  feeds: Record<string, string>;
  /** Apple TSS signing server (plain HTTP; gs.apple.com uses Apple's private CA for HTTPS). */
  tss_url: string;
  /** Apple software-update feed with release and MDM dates (not IPSW URLs). */
  gdmf_url: string;
  /** Root CA for gdmf.apple.com, fetched and pinned by SHA-256 fingerprint. */
  apple_root_ca: { url: string; sha256: string };
  /** Sent to the feeds, IPSW and OTA hosts, Tech Specs and AppleDB (not to TSS, gdmf or Wikipedia). */
  user_agent: string;
  /** Sent to gs.apple.com: the string Apple's own restore client uses. */
  tss_user_agent: string;
  http: { timeout_ms: number; retries: number };
  /** Default parallel IPSW checks (overridden by --jobs). */
  jobs: number;
  /**
   * THIRD-PARTY URL discovery for builds Apple lists in gdmf but publishes no IPSW feed for
   * (watchOS, ...). Only used to find URLs (and board hints, see ota_assets.appledb_hints); links must
   * be on an Apple host, and version, devices, names and signing are still read from the IPSW + Apple
   * TSS. Off unless enabled.
   */
  appledb: {
    enabled: boolean;
    /** {os} and {build} are substituted ({build} may carry an AppleDB suffix, e.g. "24R365-S11"). */
    url: string;
    /** Per-OS key list, used to find split entries like "watchOS;24R365-S11". {os} substituted. */
    index_url: string;
    /** gdmf device prefix -> AppleDB OS name. */
    os_for_prefix: Record<string, string>;
    allowed_hosts: string[];
  };
  /**
   * Apple's OTA asset server (gdmf.apple.com/v2/assets). For devices with no restore IPSW feed
   * (Apple TV 4K, ...), full (non-delta) OTA .zip updates carry the same BuildManifest.plist, so
   * they can be TSS-checked. Encrypted .aea assets are skipped. One audience per device prefix.
   */
  ota: {
    enabled: boolean;
    url: string;
    /** Device prefix -> Pallas AssetAudience (release channel). */
    audiences: Record<string, string>;
    /** Any older version and build; the server answers with the newest full update. */
    from_version: string;
    from_build: string;
    /** Per-prefix override of from_version and from_build (watchOS needs an old one to list 6.x and 8.x). */
    from: Record<string, [string, string]>;
    /** Device prefixes whose OTA query needs the exact HWModelStr (board), e.g. Watch. */
    needs_board: string[];
    /** mesu catalogs pairing SupportedDevices with SupportedDeviceModels (board IDs). */
    board_catalogs: string[];
    /** Optional cache of boards Apple's OTA server confirmed (skips repeat firmware lookups; "" = off). */
    boards_cache: string;
  };
  /**
   * List every OTA update (full + delta, including encrypted .aea) Apple offers per device, with URL,
   * size and decryption key, under each device's "ota_assets". Queries gdmf for every device in the report.
   */
  ota_assets: {
    enabled: boolean;
    /** Device prefix -> Pallas AssetAudience. iOS's audience covers iPhone, iPad and iPod. */
    audiences: Record<string, string>;
    /** Per-prefix base version and build to query from (default: ota.from_version, ota.from_build). */
    from: Record<string, [string, string]>;
    /** Older bases tried when the default returns nothing (devices whose last OS predates it). */
    fallback_from: [string, string][];
    /** Use AppleDB's device page for board and factory-build hints when Apple's sources have none (needs appledb.enabled). */
    appledb_hints: boolean;
    appledb_device_url: string;
    /** AppleDB's device list, to find new devices before Apple's own lists have them. */
    appledb_devices_url: string;
  };
  /**
   * Apple Tech Specs pages (support.apple.com): retail specs + product images per marketing name.
   * First-party but scraped HTML; cached on disk. Enable with --tech-specs or enabled: true.
   */
  techspecs: {
    enabled: boolean;
    base: string;
    /** support.apple.com/en-us/docs/{family} index pages to search. */
    families: string[];
    cache: string;
    /** Re-read the family indexes after this many days (to pick up new products). */
    index_max_age_days: number;
    /**
     * Product lines whose firmware name doesn't say which generation (every iPod touch is just
     * "iPod touch"). Apple numbers ProductTypes in launch order, so the Nth hardware generation
     * (iPod1, 2, 3, 4, 5, 7, 9) is Apple's "(Nth generation)" Tech Specs page. Only applied when
     * the counts match exactly; otherwise the device is left unmatched rather than guessed.
     */
    generations: { prefix: string; name: string }[];
  };
  /**
   * Chip photos from Wikimedia Commons (third-party, credited). The chip name comes from Apple Tech
   * Specs; `for_prefix` covers devices that are themselves a chip (iBridge2,x is Apple's T2).
   */
  chip_images: {
    enabled: boolean;
    api: string;
    user_agent: string;
    for_prefix: Record<string, string>;
  };
}

/** Pallas AssetAudience IDs of Apple's public release channels. */
const AUDIENCE = {
  iOS: "01c1d682-6e8f-4908-b724-5501fe3f5e5c", // also iPadOS and iPod iOS
  tvOS: "356d9da0-eee4-4c6c-bbe5-99b60eadddf0",
  watchOS: "b82fcf9c-c284-41c9-8eb2-e69bf5a5269f",
  audioOS: "0322d49d-d558-4ddf-bdff-c0443d0e6fac",
};

export const DEFAULTS: Config = {
  feeds: {
    ios: "https://itunes.apple.com/WebObjects/MZStore.woa/wa/com.apple.jingle.appserver.client.MZITunesClientCheck/version",
    macos: "https://mesu.apple.com/assets/macos/com_apple_macOSIPSW/com_apple_macOSIPSW.xml",
    // Both used by Apple Configurator: Vision Pro restores and T2 (iBridge) firmware.
    visionos: "https://mesu.apple.com/assets/visionos/com_apple_visionOSIPSW/com_apple_visionOSIPSW.xml",
    bridgeos: "https://mesu.apple.com/assets/bridgeos/com_apple_bridgeOSIPSW/com_apple_bridgeOSIPSW.xml",
  },
  tss_url: "http://gs.apple.com/TSS/controller?action=2",
  gdmf_url: "https://gdmf.apple.com/v2/pmv",
  apple_root_ca: {
    url: "https://www.apple.com/appleca/AppleIncRootCertificate.cer",
    sha256: "B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24",
  },
  user_agent: "signet/1.0 (+https://github.com/cpeoples/signet)",
  tss_user_agent: "InetURL/1.0",
  http: { timeout_ms: 60_000, retries: 4 },
  jobs: 8,
  appledb: {
    enabled: false,
    url: "https://api.appledb.dev/ios/{os};{build}.json",
    index_url: "https://api.appledb.dev/ios/{os}/index.json",
    os_for_prefix: { Watch: "watchOS", AppleTV: "tvOS", AudioAccessory: "audioOS" },
    allowed_hosts: ["updates.cdn-apple.com", "appldnld.apple.com"],
  },
  ota: {
    enabled: true,
    url: "https://gdmf.apple.com/v2/assets",
    audiences: { AppleTV: AUDIENCE.tvOS, Watch: AUDIENCE.watchOS },
    from_version: "18.0",
    from_build: "22J357",
    from: { Watch: ["4.0", "15R372"] },
    needs_board: ["Watch"],
    board_catalogs: ["https://mesu.apple.com/assets/watch/com_apple_MobileAsset_SoftwareUpdate/com_apple_MobileAsset_SoftwareUpdate.xml"],
    boards_cache: "apple-boards.json",
  },
  ota_assets: {
    enabled: true,
    audiences: {
      iPhone: AUDIENCE.iOS, iPad: AUDIENCE.iOS, iPod: AUDIENCE.iOS,
      AppleTV: AUDIENCE.tvOS, Watch: AUDIENCE.watchOS, AudioAccessory: AUDIENCE.audioOS,
    },
    from: {
      iPhone: ["15.0", "19A346"], iPad: ["15.0", "19A346"], iPod: ["12.0", "16A366"],
      Watch: ["4.0", "15R372"],
    },
    fallback_from: [["10.0", "14A403"], ["7.0", "11A465"]],
    appledb_hints: true,
    appledb_device_url: "https://appledb.dev/pageData/device/{id}.json",
    appledb_devices_url: "https://api.appledb.dev/device/main.json",
  },
  techspecs: {
    enabled: false,
    base: "https://support.apple.com/en-us",
    families: ["iphone", "ipad", "watch", "mac", "apple-tv", "homepod", "vision", "ipod"],
    cache: "apple-techspecs.json",
    index_max_age_days: 7,
    generations: [{ prefix: "iPod", name: "iPod touch" }],
  },
  chip_images: {
    enabled: true,
    api: "https://en.wikipedia.org/w/api.php",
    user_agent: "signet/1.0 (+https://github.com/cpeoples/signet; chip photos with attribution)",
    for_prefix: { "iBridge1,": "T1", "iBridge2,": "T2" },
  },
};

export const DEFAULT_CONFIG_FILE = "signet.config.json";

/** Active config (module-level so every module reads the same values). */
export let CONFIG: Config = DEFAULTS;

export function loadConfig(path?: string): Config {
  const file = path ?? (existsSync(DEFAULT_CONFIG_FILE) ? DEFAULT_CONFIG_FILE : undefined);
  if (!file) return (CONFIG = DEFAULTS);
  let user: Partial<Config>;
  try {
    user = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`can't read config ${file}: ${errorMessage(e)}`, { cause: e });
  }
  CONFIG = {
    ...DEFAULTS,
    ...user,
    feeds: user.feeds ?? DEFAULTS.feeds, // replace, so feeds can be removed
    apple_root_ca: { ...DEFAULTS.apple_root_ca, ...user.apple_root_ca },
    http: { ...DEFAULTS.http, ...user.http },
    appledb: { ...DEFAULTS.appledb, ...user.appledb },
    ota: { ...DEFAULTS.ota, ...user.ota },
    ota_assets: { ...DEFAULTS.ota_assets, ...user.ota_assets },
    techspecs: { ...DEFAULTS.techspecs, ...user.techspecs },
    chip_images: { ...DEFAULTS.chip_images, ...user.chip_images },
  };
  if (!Object.keys(CONFIG.feeds).length) throw new Error(`config ${file}: "feeds" is empty`);
  return CONFIG;
}

export const ua = () => ({ "User-Agent": CONFIG.user_agent });
