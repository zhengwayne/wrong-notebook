import { readSiteVerifyFile } from "@/lib/server/site-verify";

export const dynamic = "force-dynamic";

/** 公开：根路径 /<name>.txt 由 proxy 改写到这里，返回配置目录 site-verify/ 下的同名文件 */
export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
    const { name } = await params;
    const content = await readSiteVerifyFile(name);
    if (content === null) {
        return new Response("Not Found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    return new Response(content, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
