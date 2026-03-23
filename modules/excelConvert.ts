import * as xlsx from 'xlsx';
import Papa from 'papaparse';
import type { AstelavStockResponse, CSVRow } from '../types';

const CUSTOMER_ID = process.env.ASTELAV_CUSTOMER_ID?.trim();
const API_TOKEN = process.env.environment === 'TEST'
    ? process.env.ASTELAV_TEST_API_TOKEN?.trim()
    : process.env.ASTELAV_LIVE_API_TOKEN?.trim();
const BASE_HOST = process.env.environment === 'TEST' ? 'stagingapi' : 'api';

if (!CUSTOMER_ID || !API_TOKEN) {
    throw new Error('Set ASTELAV_CUSTOMER_ID and ASTELAV_[TEST|LIVE]_API_TOKEN.');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chunkBatch<T>(array: T[], size: number): T[][] {
    return Array.from(
        { length: Math.ceil(array.length / size) },
        (_, i) => array.slice(i * size, i * size + size)
    );
}

async function getBatchStockData(skus: string[]): Promise<AstelavStockResponse | null> {
    const url = `https://${BASE_HOST}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/products?token=${API_TOKEN}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
            pricing_list_explanation: false,
            products: skus.map((sku) => ({ sku, quantity: 1 })),
        }),
    });
    if (!res.ok) return null;
    return res.json() as Promise<AstelavStockResponse>;
}

// ─── Excel reader ─────────────────────────────────────────────────────────────

function readExcel(filePath: string) {
    const workbook: xlsx.WorkBook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('El archivo Excel no contiene ninguna hoja.');
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`No se encontró la hoja "${sheetName}".`);

    const rawRows = xlsx.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
    const seen = new Set<string>();

    return rawRows
        .map((r) => ({
            SKU: String(r['SKU'] ?? ''),
            MPN: String(r['MPN'] ?? ''),
            product_type: String(r['product_type'] ?? ''),
            ProductName: String(r['ProductName'] ?? ''),
            BrandId: String(r['BrandId'] ?? ''),
            BrandDescription: String(r['BrandDescription'] ?? ''),
            settore: String(r['settore'] ?? ''),
        }))
        .filter((r) => {
            if (!r.SKU.trim() || !r.ProductName.trim()) return false;
            if (seen.has(r.SKU)) return false;
            seen.add(r.SKU);
            return true;
        });
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function convertCatalogue(filePath: string): Promise<CSVRow[]> {
    console.log('Leyendo catálogo Excel...');
    const excelRows = readExcel(filePath);
    console.log(`${excelRows.length} filas válidas. Consultando precios y stock...`);

    const allSkus = excelRows.map((r) => r.SKU);
    const batches = chunkBatch(allSkus, 300);

    // Fetch all prices in batches of 300, merge into a single map
    const priceMap = new Map<string, { price: string; stock: string }>();
    let done = 0;

    for (const batch of batches) {
        const stockData = await getBatchStockData(batch);
        if (stockData) {
            for (const sku of batch) {
                const detail = stockData[sku];
                if (detail) {
                    if (!detail.price || detail.price == 0 || !detail.stock || detail.stock.availableQuantity == 0) {
                        console.log(`[WARN] ${sku} no tiene stock o precio. Saltando`);
                        continue;
                    }
                    const price = detail.price !== undefined && detail.price !== ''
                        ? String(detail.price)
                        : '0.00';
                    const raw = detail.stock?.availableQuantity;
                    const stock = String(
                        isNaN(parseInt(String(raw ?? '0'), 10))
                            ? 0
                            : parseInt(String(raw ?? '0'), 10)
                    );
                    priceMap.set(sku, { price, stock });
                }
            }
        } else {
            console.warn(`[WARN] getBatchStockData falló para un lote de ${batch.length} SKUs.`);
        }

        done += batch.length;
        if (done % 3000 === 0) {
            console.log(`  Precios: ${done}/${allSkus.length} consultados...`);
        }
    }

    console.log(`Precios obtenidos para ${priceMap.size}/${allSkus.length} SKUs.`);

    const rows: CSVRow[] = excelRows.map((r): CSVRow => {
        const live = priceMap.get(r.SKU);
        return {
            id: r.SKU.trim(),
            title: r.ProductName.trim(),
            price: live?.price ?? '0.00',
            sale_price: live?.price ?? '0.00',
            stock: live?.stock ?? '0',
            image_link: '',
            DESCRIPTION: r.ProductName.trim(),
            vendor: r.BrandDescription.trim(),
            product_type: r.settore.trim(),
            tags: r.product_type.trim(),
            mpn: r.MPN.trim(),
            brand_id: r.BrandId.trim(),
        };
    });

    console.log(`${rows.length} productos listos.`);
    return rows;
}

export async function writeCatalogueCsv(rows: CSVRow[], outputPath: string): Promise<void> {
    const csv = Papa.unparse(rows, { delimiter: ';' });
    await Bun.write(outputPath, '\uFEFF' + csv);
    console.log(`[OK] CSV guardado en: ${outputPath}`);
}