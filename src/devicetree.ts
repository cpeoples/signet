/** Read an IPSW DeviceTree (IM4P container, LZFSE payload): ProductType, marketing name, properties. */
import { lzfseDecompress } from "@chrispeoples/aea";

function der(buf: Buffer, i: number): { tag: number; val: Buffer; next: number } {
  const tag = buf[i];
  let n = buf[i + 1];
  i += 2;
  if (n & 0x80) {
    const k = n & 0x7f;
    n = 0;
    for (let j = 0; j < k; j++) n = n * 256 + buf[i + j];
    i += k;
  }
  return { tag, val: buf.subarray(i, i + n), next: i + n };
}

export function im4pPayload(blob: Buffer): Buffer {
  const seq = der(blob, 0).val;
  const items: Buffer[] = [];
  for (let i = 0; i < seq.length;) {
    const d = der(seq, i);
    items.push(d.val);
    i = d.next;
  }
  if (items[0]?.toString("latin1") !== "IM4P") throw new Error("not IM4P");
  // IM4P SEQUENCE: "IM4P", type, description, payload (LZFSE-compressed when it starts with "bvx").
  const payload = items[3];
  return payload.subarray(0, 3).toString("latin1") === "bvx" ? lzfseDecompress(payload) : payload;
}

/** NUL-terminated string property; undefined when absent or empty. */
export const cstr = (b?: Buffer) => {
  if (!b?.length) return undefined;
  const end = b.indexOf(0);
  return b.subarray(0, end < 0 ? b.length : end).toString("utf8");
};

export type DtNode = { path: string; props: Record<string, Buffer> };

const PROP_NAME_LEN = 32;
/** Top bit of a property length is a flag, not part of the size. */
const PROP_LEN_MASK = 0x7fffffff;

/** Flatten a DeviceTree into nodes with slash paths ("/device-tree/product", "/device-tree/cpus/cpu0"). */
export function parseDeviceTree(blob: Buffer): DtNode[] {
  const raw = im4pPayload(blob);
  const nodes: DtNode[] = [];
  const node = (i: number, parent: string): number => {
    const nprops = raw.readUInt32LE(i), nchild = raw.readUInt32LE(i + 4);
    i += 8;
    const props: Record<string, Buffer> = {};
    for (let n = 0; n < nprops; n++) {
      const name = cstr(raw.subarray(i, i + PROP_NAME_LEN))!;
      const len = raw.readUInt32LE(i + PROP_NAME_LEN) & PROP_LEN_MASK;
      const start = i + PROP_NAME_LEN + 4;
      props[name] = raw.subarray(start, start + len);
      i = start + ((len + 3) & ~3); // values are padded to 4 bytes
    }
    const path = `${parent}/${cstr(props["name"]) ?? ""}`;
    nodes.push({ path, props });
    for (let c = 0; c < nchild; c++) i = node(i, path);
    return i;
  };
  node(0, "");
  return nodes;
}

/** ProductType this DeviceTree describes (root "compatible", e.g. "iPhone17,1"). */
export function devicetreeProduct(nodes: DtNode[]): string | undefined {
  const compat = (nodes[0]?.props["compatible"]?.toString("utf8") ?? "").split("\0").filter(Boolean);
  return compat.find((c) => c.includes(",") && !c.endsWith("AP"));
}

/** Marketing name from the product node ("iPhone 16 Pro"). */
export function devicetreeName(nodes: DtNode[]): string | undefined {
  const product = nodes.find((n) => n.path === "/device-tree/product")?.props ?? {};
  return cstr(product["product-name"]) || cstr(product["product-description"]);
}
