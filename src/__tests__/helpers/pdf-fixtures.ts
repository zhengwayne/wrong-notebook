/**
 * 生成测试用的极简 PDF（纯矢量图形，不依赖字体），供单元测试和 E2E 共用。
 * - makePdf(n)：n 页 A4，每页画 n 条黑色横条以便区分
 * - makePdf(n, { encrypted: true })：带标准安全处理器且用户口令非空（无法用空口令打开）
 * - makeCorruptPdf()：不是合法 PDF 的内容
 */
export function makePdf(pageCount: number, options: { encrypted?: boolean } = {}): Buffer {
    const objects: string[] = [];
    const pageIds: number[] = [];
    // 1 Catalog, 2 Pages, 之后每页两个对象（Page + Contents）
    for (let index = 0; index < pageCount; index += 1) {
        const pageId = 3 + index * 2;
        pageIds.push(pageId);
        const bars = Array.from({ length: index + 1 }, (_, bar) => `0 0 0 rg 72 ${700 - bar * 60} 300 30 re f`).join("\n");
        objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${pageId + 1} 0 R /Resources << >> >>`;
        objects[pageId + 1] = `<< /Length ${Buffer.byteLength(bars)} >>\nstream\n${bars}\nendstream`;
    }
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
    let encryptRef = "";
    if (options.encrypted) {
        const id = objects.length;
        const hex32 = (seed: string) => Buffer.from(seed.padEnd(32, seed)).subarray(0, 32).toString("hex");
        objects[id] = `<< /Filter /Standard /V 1 /R 2 /O <${hex32("owner-secret")}> /U <${hex32("user-secret!")}> /P -44 >>`;
        encryptRef = ` /Encrypt ${id} 0 R`;
    }

    let body = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
    const offsets: number[] = [];
    for (let id = 1; id < objects.length; id += 1) {
        offsets[id] = Buffer.byteLength(body, "latin1");
        body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xrefAt = Buffer.byteLength(body, "latin1");
    body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id += 1) body += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    const fileId = "0123456789abcdef0123456789abcdef";
    body += `trailer\n<< /Size ${objects.length} /Root 1 0 R /ID [<${fileId}> <${fileId}>]${encryptRef} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return Buffer.from(body, "latin1");
}

export function makeCorruptPdf(): Buffer {
    return Buffer.from("this is not a pdf at all, just some bytes that pretend to be one\n".repeat(20), "latin1");
}
