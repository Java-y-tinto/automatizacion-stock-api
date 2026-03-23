/**
 * index.ts
 * 
 * Entry point for the Astelav → Shopify catalogue upload pipeline.
 * 
 * Steps:
 *  1. Convert Excel catalogue to a clean CSV (for inspection/debugging)
 *  2. Generate a Shopify JSONL bulk file (with live price, stock and images)
 *  3. Submit the JSONL to Shopify via productSet bulk mutation
 *  4. Poll until Shopify finishes and report the result
 */

import { convertCatalogue, writeCatalogueCsv } from './modules/excelConvert';
import { uploadCatalogue } from './uploadCatalogue';
import { subirArchivoShopify } from './modules/staged_upload';
import { publicarProductosBulk } from './modules/publish';
const EXCEL_PATH = process.env.CATALOGUE_EXCEL_PATH ?? './20260302completeCatalogue_stocking_en.xlsx';
const CSV_PATH = './catalogue_clean.csv';


// ─── Main pipeline ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const start = Date.now();
    console.log('=== Astelav → Shopify Catalogue Pipeline ===\n');

    // 1. Convert Excel → clean CSV
    console.log('[1/4] Convirtiendo catálogo Excel a CSV limpio...');
    const rows = await convertCatalogue(EXCEL_PATH);
    await writeCatalogueCsv(rows, CSV_PATH);
    console.log(`[OK] CSV generado: ${CSV_PATH} (${rows.length} productos)\n`);

    // 2. Generate JSONL (fetches live prices, stock and images from Astelav)
    console.log('[2/4] Generando JSONL con datos en vivo de Astelav...');
    const jsonlPath = await uploadCatalogue(EXCEL_PATH);
    console.log(`[OK] JSONL generado: ${jsonlPath}\n`);

    // 3+4. Submit to Shopify and wait for completion
    const bulkId = await subirArchivoShopify(jsonlPath);
    // publish
    const publishingFile = await publicarProductosBulk(bulkId);

    const elapsed = ((Date.now() - start) / 1000 / 60).toFixed(1);
    console.log(`\n=== Pipeline completado en ${elapsed} minutos ===`);
}

main().catch((err) => {
    console.error(`\n[FATAL] ${err}`);
    process.exit(1);
});