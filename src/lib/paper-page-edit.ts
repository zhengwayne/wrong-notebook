/** 试卷页编辑：旋转、把裁剪结果转成 data URL（仅浏览器环境） */

function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("IMAGE_LOAD_FAILED"));
        image.src = src;
    });
}

export async function rotateDataUrl(src: string, degrees: 90 | -90 | 180): Promise<string> {
    const image = await loadImage(src);
    const canvas = document.createElement("canvas");
    const quarter = Math.abs(degrees) % 180 === 90;
    canvas.width = quarter ? image.height : image.width;
    canvas.height = quarter ? image.width : image.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法获取 Canvas 上下文");
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(image, -image.width / 2, -image.height / 2);
    return canvas.toDataURL("image/jpeg", 0.82);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}
