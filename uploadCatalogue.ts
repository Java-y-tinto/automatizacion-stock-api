/**
 * uploadCatalogue.ts
 *
 * Reads the Astelav product catalogue from an Excel file, enriches each SKU
 * with live price/stock data from the Astelav API, fetches and uploads images
 * to Shopify via the pool from processAstelavImages.ts, then writes a JSONL
 * bulk file ready for productSet mutation.
 */

import * as xlsx from 'xlsx';
import { transformToShopifyJSONL, obtenerMapaProductos, getProductDetails, getBatchStockData } from './modules/batch_processing';
import { graphql } from './modules/functions';
import type {
    AstelavSearchResponse,
    AstelavStockResponse,
    AstelavStockDetails,
    AstelavProductDetails,
} from './types';

// ─── Config ──────────────────────────────────────────────────────────────────

const CUSTOMER_ID = process.env.ASTELAV_CUSTOMER_ID?.trim();
const API_TOKEN = process.env.environment === 'TEST'
    ? process.env.ASTELAV_TEST_API_TOKEN?.trim()
    : process.env.ASTELAV_LIVE_API_TOKEN?.trim();
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID?.trim();
const COLLECTION_HANDLE = 'sspelectronic-drops';

if (!CUSTOMER_ID || !API_TOKEN || !LOCATION_ID) {
    throw new Error('Set ASTELAV_CUSTOMER_ID, ASTELAV_[TEST|LIVE]_API_TOKEN and SHOPIFY_LOCATION_ID.');
}

const BASE_HOST = process.env.environment === 'TEST' ? 'stagingapi' : 'api';

// ─── Types ────────────────────────────────────────────────────────────────────

type ExcelRow = {
    SKU: string;
    MPN: string;
    product_type: string;   // OEM | Adaptable | Original
    ProductName: string;
    BrandId: string;
    BrandDescription: string;
    settore: string;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkBatch<T>(array: T[], size: number): T[][] {
    return Array.from(
        { length: Math.ceil(array.length / size) },
        (_, i) => array.slice(i * size, i * size + size)
    );
}

function toHandle(title: string, sku: string): string {
    return `${title}-${sku}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
}

function parseQuantity(raw: string | number | undefined): number {
    if (raw === undefined || raw === null) return 0;
    const parsed = parseInt(String(raw).replace(/\D/g, ''), 10);
    return isNaN(parsed) ? 0 : parsed;
}

// ─── Excel reader ─────────────────────────────────────────────────────────────

function readCatalogue(filePath: string): ExcelRow[] {
    console.log('Leyendo catálogo Excel...');
    const workbook: xlsx.WorkBook = xlsx.readFile(filePath);

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('El archivo Excel no contiene ninguna hoja.');

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`No se encontró la hoja "${sheetName}".`);

    const rawRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    const rows: ExcelRow[] = rawRows.map((r) => ({
        SKU: String(r.SKU ?? ''),
        MPN: String(r.MPN ?? ''),
        product_type: String(r.product_type ?? ''),
        ProductName: String(r.ProductName ?? ''),
        BrandId: String(r.BrandId ?? ''),
        BrandDescription: String(r.BrandDescription ?? ''),
        settore: String(r.settore ?? ''),
    }));
    console.log(`${rows.length} filas leídas del catálogo.`);
    return rows;
}

// ─── Shopify: collection GID lookup ──────────────────────────────────────────

async function obtenerCollectionId(handle: string): Promise<string> {
    const res = await graphql(`
        query {
            collectionByHandle(handle: "${handle}") { id }
        }
    `);
    const id = res.collectionByHandle?.id;
    if (!id) throw new Error(`No se encontró la colección "${handle}". Créala primero en Shopify.`);
    console.log(`Colección "${handle}" → ${id}`);
    return id;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function uploadCatalogue(excelPath: string): Promise<string> {
    const outputPath = `catalogue_bulk_${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`;
    const writer = Bun.file(outputPath).writer();

    // 1. Read Excel
    const excelRows = readCatalogue(excelPath);
    const excelMap = new Map<string, ExcelRow>(excelRows.map((r) => [r.SKU, r]));
    const allSkus = [...new Set(excelRows.map((r) => r.SKU).filter(Boolean))];
    console.log(`${allSkus.length} SKUs únicos en el catálogo.`);

    // 2. Fetch existing Shopify products + collection ID in parallel
    const productosExistentes = await obtenerMapaProductos();

    // 3. Split into new vs existing — only new products need image fetching
    const skusNuevos = allSkus.filter((sku) => !productosExistentes.has(sku));
    const skusExistentes = allSkus.filter((sku) => productosExistentes.has(sku));
    console.log(`${skusExistentes.length} existentes (sin imágenes), ${skusNuevos.length} nuevos (con imágenes).`);

    // 4. Pre-fetch all images for new SKUs using the pool from processAstelavImages.ts
    //    This runs skuConcurrency SKUs in parallel, each respecting the 1s/image delay.
    /*
    console.log('Descargando imágenes para productos nuevos...');
    let imagesDone = 0;
    const imageMap = await processAllImages(
        skusNuevos,
        (sku: string, urls: string[], done: number, total: number) => {
            imagesDone++;
            process.stdout.write(`\rImágenes: [${done}/${total}] ${sku} → ${urls.length} imágenes\r`);
            
            if (imagesDone % 100 === 0) {
                console.log(`  Imágenes: [${done}/${total}] ${sku} → ${urls.length} imágenes`);
            }
                
        },
    );
    */

    // 5. Process existing first, then new — in batches of 300 for Astelav stock API
    const orderedSkus = [...skusExistentes, ...skusNuevos];
    const batches = chunkBatch(orderedSkus, 300);
    let processed = 0;
    let written = 0;
    let skipped = 0;

    console.log(`Procesando ${batches.length} lotes de hasta 300 SKUs...`);

    for (const batch of batches) {
        try {
            const stockDataMassive = await getBatchStockData(batch as string[]);
            if (!stockDataMassive) continue;

            const searchDataArray = await Promise.all(batch.map((sku) => getProductDetails(sku)));

            if (!stockDataMassive) {
                console.warn('[WARN] getBatchStockData falló para un lote, se omite.');
                skipped += batch.length;
                continue;
            }

            for (let i = 0; i < batch.length; i++) {
                const sku = batch[i]!;
                const excelRow = excelMap.get(sku);
                if (!excelRow) continue;
                /*
                const line = await transformToShopifyJSONL(
                    sku,
                    excelRow,
                    searchDataArray[i] ?? null,
                    stockDataMassive[sku],
                    productosExistentes.get(sku),
                    imageMap.get(sku) ?? [],  // already fetched — no await needed
                    collectionId,
                );
                */
                const line = await transformToShopifyJSONL(
                    sku,
                    searchDataArray[i]! as AstelavSearchResponse,
                    stockDataMassive! as AstelavStockResponse,
                    productosExistentes.get(sku),
                );

                if (line) {
                    writer.write(line + '\n');
                    written++;
                } else {
                    skipped++;
                }

                processed++;
                if (processed % 500 === 0) {
                    console.log(`[${processed}/${allSkus.length}] procesados, ${written} escritos, ${skipped} omitidos`);
                    writer.flush();
                }
            }

        } catch (error) {
            console.error(`[${new Date().toISOString()}] Error en lote: ${error}`);
            skipped += batch.length;
        }
    }

    writer.flush();
    writer.end();

    console.log(`\n Completado.`);
    console.log(`   Total procesados: ${processed}`);
    console.log(`   Escritos al JSONL: ${written}`);
    console.log(`   Omitidos (sin stock, descatalogados, errores): ${skipped}`);
    console.log(`   Archivo: ${outputPath}`);
    return outputPath;
}