import { createReadStream, ReadStream } from "fs";
import readline from "readline";
import type { JsonlLine } from "./types";
import { processAstelavImagesForExistingProduct } from "./modules/images";
import { graphql } from "./modules/functions";


async function getProductId(handle: string): Promise<string | null> {
    const query = `
        query getProduct($identifier: ProductIdentifierInput!) {
            product: productByIdentifier(identifier: $identifier) {
                id
            }
        }
    `;

    // Pasamos el handle dentro del objeto identifier
    const variables = {
        identifier: {
            handle: handle
        }
    };

    try {
        const response = await graphql(query, variables);
        return response.product?.id || null;
    } catch (error) {
        console.error(`Error obteniendo el ID para el handle ${handle}:`, error);
        return null;
    }
}



export async function procesarImagenesJSONL() {
    const fileStream: ReadStream = createReadStream("./catalogue_bulk_2026-03-13T12-16-15-132Z.jsonl");

    const rl: readline.Interface = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const objeto: JsonlLine = JSON.parse(line);

            const sku = objeto.input.variants[0]?.sku;
            const handle = objeto.input.handle;

            if (!sku) continue;
            console.log(`Procesando SKU: ${sku}`);
            const productId = await getProductId(handle);
            if (!productId) continue;
            await processAstelavImagesForExistingProduct(sku, productId);
        } catch (error) {
            console.error(`Error al procesar la línea: ${error}`);
        }
    }
}

procesarImagenesJSONL();