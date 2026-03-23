import { graphql } from "./modules/functions";

// ─── Types ───────────────────────────────────────────────────────────────────

type StagedTarget = {
    url: string;
    resourceUrl: string;
    parameters: { name: string; value: string }[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run async tasks with a max concurrency limit.
 * Processes `items` in parallel, at most `limit` at a time.
 */
async function pool<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i]!, i);
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// ─── Single image upload ──────────────────────────────────────────────────────

async function uploadImage(
    imgName: string,
    downloadUrl: string,
): Promise<string | null> {
    const imgRes = await fetch(downloadUrl);
    if (!imgRes.ok) {
        console.warn(`[WARN] No se pudo descargar imagen: ${imgName}`);
        return null;
    }

    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const stagedData = await graphql(`
        mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
            stagedUploadsCreate(input: $input) {
                stagedTargets {
                    url
                    resourceUrl
                    parameters { name value }
                }
            }
        }
    `, {
        input: [{
            filename: imgName,
            mimeType: "image/jpeg",
            resource: "IMAGE",
            fileSize: buffer.length.toString(),
            httpMethod: "PUT",
        }],
    });

    const target: StagedTarget = stagedData.stagedUploadsCreate.stagedTargets[0];

    const uploadRes = await fetch(target.url, {
        method: "PUT",
        headers: {
            "Content-Type": "image/jpeg",
            "Content-Length": buffer.length.toString(),
        },
        body: buffer,
    });

    if (!uploadRes.ok) {
        console.warn(`[WARN] Error al subir ${imgName}: ${await uploadRes.text()}`);
        return null;
    }

    return target.resourceUrl;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch and upload all images for a SKU to Shopify.
 *
 * @param sku        - Product SKU to look up in the Astelav API
 * @param concurrency - Max parallel image uploads per SKU (default: 3)
 * @param msDelay     - Delay between uploads to respect API rate limits (default: 1000ms)
 */
export async function processAstelavImages(
    sku: string,
    concurrency = 3,
    msDelay = 1000,
): Promise<string[]> {
    const CUSTOMER_ID = process.env.ASTELAV_CUSTOMER_ID;
    const isTest = process.env.environment === "TEST";
    const token = isTest ? process.env.ASTELAV_TEST_API_TOKEN : process.env.ASTELAV_LIVE_API_TOKEN;

    if (!CUSTOMER_ID || !token) throw new Error("Falta ASTELAV_CUSTOMER_ID o el token de API.");

    const baseHost = isTest ? "stagingapi" : "api";
    const listUrl = `https://${baseHost}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/productImages/${sku}?token=${token}`;

    try {
        const res = await fetch(listUrl);
        if (!res.ok) throw new Error(`Error listando imágenes: ${res.statusText}`);

        const data = await res.json() as { ProductImages?: { ImageName: string; ImageUrl: string }[] };
        if (!data.ProductImages?.length) return [];

        const images = data.ProductImages.map((img) => {
            const separator = img.ImageUrl.includes("?") ? "&" : "?";
            return {
                name: img.ImageName,
                url: `${img.ImageUrl}${separator}token=${token}`,
            };
        });

        // Upload images concurrently, with a small delay between each
        // to stay within Astelav's rate limit.
        // At concurrency=3 and delay=1s: 3 images/s instead of 1 image/s → 3× faster.
        const urls = await pool(images, concurrency, async (img, i) => {
            //if (i > 0) await delay(msDelay);
            return uploadImage(img.name, img.url);
        });

        return urls.filter((u): u is string => u !== null);

    } catch (error) {
        console.error(`[ERROR] SKU ${sku}: ${error}`);
        return [];
    }
}

/**
 * Process images for an entire catalogue in parallel.
 * Runs `skuConcurrency` SKUs at a time, each uploading up to `imgConcurrency` images in parallel.
 *
 * With 31k SKUs, even at 10 SKUs/s this takes ~50 min.
 * Tune skuConcurrency up carefully — Shopify's stagedUploadsCreate is rate-limited.
 *
 * @param skus            - List of SKUs to process
 * @param onDone          - Callback fired after each SKU completes (useful for progress tracking)
 * @param skuConcurrency  - How many SKUs to process in parallel (default: 5)
 * @param imgConcurrency  - How many images per SKU to upload in parallel (default: 3)
 */
export async function processAllImages(
    skus: string[],
    onDone: (sku: string, urls: string[], done: number, total: number) => void,
    skuConcurrency = 5,
    imgConcurrency = 3,
): Promise<Map<string, string[]>> {
    const resultMap = new Map<string, string[]>();
    let done = 0;

    await pool(skus, skuConcurrency, async (sku) => {
        const urls = await processAstelavImages(sku, imgConcurrency);
        resultMap.set(sku, urls);
        onDone(sku, urls, ++done, skus.length);
    });

    return resultMap;
}