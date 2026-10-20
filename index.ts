import { subirArchivoShopify, vigilarOperacion, verErroresBulk, PRODUCT_DELETE_MUTATION } from "./modules/staged_upload";
import { processSKUs } from "./modules/batch_processing";
import { publicarProductosBulk } from "./modules/publish";

async function main() {
    const starTime = performance.now();
    let publishingFile: string | null = null;
    try {
        // Creacion y actualizacion de los productos
        const { file, deleteFile } = await processSKUs();

        const bulkId = await subirArchivoShopify(file.name!);
        await vigilarOperacion(bulkId);
        await verErroresBulk(bulkId);

        // Publicacion
        console.log(`[${new Date(Date.now()).toISOString()}] [INFO] Publicando`)
        publishingFile = await publicarProductosBulk(bulkId);

        // Borrado de productos sin stock (despues: Shopify solo admite un bulk mutation a la vez)
        if (deleteFile) {
            console.log(`[${new Date(Date.now()).toISOString()}] [INFO] Borrando productos sin stock`)
            const deleteBulkId = await subirArchivoShopify(deleteFile.name!, PRODUCT_DELETE_MUTATION);
            await vigilarOperacion(deleteBulkId);
            await verErroresBulk(deleteBulkId);
        }
    } catch (error) {
        console.error(`[${new Date(Date.now()).toISOString()}] Error fatal: ${error}`);
        process.exit(1);
    } finally {
        const endTime = performance.now();
        const memoryData = process.memoryUsage();

        const time = ((endTime - starTime) / 1000).toFixed(2);
        const usedMegabytesRAM = Math.round(memoryData.heapUsed / 1024 / 1024);
        const totalAssignedRAM = Math.round(memoryData.rss / 1024 / 1024);

        console.log(`\n--- MÉTRICAS DE CONSUMO ---`);
        console.log(`Tiempo total: ${time} segundos`);
        console.log(`RAM (Variables/Lotes): ${usedMegabytesRAM} MB`);
        console.log(`RAM (Total proceso Bun): ${totalAssignedRAM} MB`);
        console.log(`---------------------------\n`);

        // limpieza de archivos si existen
        if (publishingFile && await Bun.file(publishingFile).exists()) {
            await Bun.file(publishingFile).delete();
        }
    }
}

main();