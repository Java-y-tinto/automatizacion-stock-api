import type { BunFile } from "bun";
import type { AstelavSearchResponse, AstelavStockResponse, PricingRule } from "../types";
import { processAstelavImages } from "./images";
import { graphql } from "./functions";

const MINUTES = 1400;
const CUSTOMER_ID = process.env.ASTELAV_CUSTOMER_ID?.trim();
const API_TOKEN = (process.env.environment! == "TEST") ? process.env.ASTELAV_TEST_API_TOKEN?.trim() : process.env.ASTELAV_LIVE_API_TOKEN?.trim();
const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID?.trim();

if (!CUSTOMER_ID || !API_TOKEN || !LOCATION_ID) {
    throw new Error(
        'Set ASTELAV_CUSTOMER_ID, ASTELAV_TEST_API_TOKEN and SHOPIFY_LOCATION_ID.'
    );
}

function chunkBatch<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, i) => array.slice(i * size, i * size + size)) // divide el array en chunks de tamaño size
}

// Obtencion de los SKUs por lotes para no saturar memoria
async function* getChangedSKUs() {
    let page = 1;
    let totalPages = 1; // la propia respuesta nos da las paginas totales
    while (page <= totalPages) {
        const url = `https://${(process.env.environment! == "TEST") ? "stagingapi" : "api"}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/changedStockProducts/${MINUTES}?page=${page}&token=${API_TOKEN}`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });
        const date = new Date(Date.now()).toISOString();
        if (!response.ok) throw new Error(`[${date}] Fallo al obtener SKUs: ${response.status}`)

        const data: any = await response.json();
        totalPages = data.TotalPages; // actualizamos el total de paginas
        const skus = data.Products.map((item: { sku: string }) => item.sku);

        //console.log(`[DEBUG] Pagina ${page}: ${skus.length} SKUs`);
        // console.log(`[DEBUG] Total de paginas: ${totalPages}`);
        // console.log(`[DEBUG] SKU: ${skus}`);
        if (skus.length === 0) {
            break; // fin de paginacion de API o fallo de la propia API
        }

        yield skus;
        page++;
    }
}

// Obtenemos los productos que ya estan creados para ahorrarnos horas de tiempo de ejecucion en duplicados

export async function obtenerMapaProductos() {
    console.log("Solicitando volcado de productos existentes a Shopify...");

    // 1. Lanzamos la operación de lectura masiva
    const queryInit = `
        mutation {
          bulkOperationRunQuery(
            query: """
            {
              products {
                edges {
                  node {
                    id
                    variants {
                      edges {
                        node {
                          id
                          sku
                        }
                      }
                    }
                  }
                }
              }
            }
            """
          ) {
            bulkOperation {
              id
              status
            }
            userErrors {
              message
            }
          }
        }
    `;

    const initRes = await graphql(queryInit);
    const bulkId = initRes.bulkOperationRunQuery?.bulkOperation?.id;

    if (!bulkId) {
        throw new Error("No se pudo iniciar la consulta Bulk en Shopify.");
    }

    // 2. Hacemos polling hasta que Shopify termine de generar el archivo
    console.log(`Esperando a que Shopify genere el diccionario (ID: ${bulkId})...`);
    let urlDescarga = null;

    while (true) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Esperamos 5 segundos
        const pollRes = await graphql(`
            query {
                node(id: "${bulkId}") {
                    ... on BulkOperation {
                        status
                        url
                    }
                }
            }
        `);

        const status = pollRes.node.status;
        if (status === 'COMPLETED') {
            urlDescarga = pollRes.node.url;
            break;
        } else if (status === 'FAILED' || status === 'CANCELED') {
            throw new Error(`La operación de lectura falló o se canceló: ${status}`);
        }
    }

    // 3. Descargamos y procesamos el JSONL devuelto
    const mapa = new Map();
    if (!urlDescarga) {
        console.log("No hay productos previos en la tienda. Se crearán todos desde cero.");
        return mapa;
    }

    console.log("Volcado completado. Procesando IDs...");
    const response = await fetch(urlDescarga);
    const text = await response.text();
    const lineas = text.split('\n').filter(line => line.trim() !== '');

    for (const linea of lineas) {
        const data = JSON.parse(linea);
        // Shopify Bulk API devuelve las variantes con el campo __parentId que apunta al ID del producto
        if (data.sku && data.__parentId) {
            mapa.set(data.sku, {
                productId: data.__parentId,
                variantId: data.id
            });
        }
    }

    console.log(`Diccionario listo: ${mapa.size} productos encontrados en Shopify.`);
    return mapa;
}


// Obtenemos informacion del producto con su SKU

export async function getProductDetails(sku: string) {
    const isoLang = 'en'; // Idioma de nombre y descripcion

    const url = `https://${(process.env.environment! == "TEST") ? "stagingapi" : "api"}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/search/${encodeURIComponent(sku)}/${isoLang}/?token=${API_TOKEN}`;
    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Accept': 'application/json',
        },
    });
    if (!response.ok) return null;
    return await response.json();
}

// Obtenemos el precio de los productos de forma masiva, en lotes de 300 
export async function getBatchStockData(skus: string[]) {
    const url = `https://${(process.env.environment! == "TEST") ? "stagingapi" : "api"}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/products?token=${API_TOKEN}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            pricing_list_explanation: false,
            products: skus.map((sku) => ({ sku: sku, quantity: 1 }))
        }),
    });
    if (!response.ok) return null;
    return await response.json();
}

// Reglas de incremento de precio
const pricingRules: PricingRule[] = [
    {
        maxCost: 10,
        incrementPercentage: 100
    },
    {
        maxCost: 20,
        incrementPercentage: 80
    },
    {
        maxCost: 30,
        incrementPercentage: 60
    },
    {
        maxCost: 50,
        incrementPercentage: 50
    },
    {
        maxCost: 70,
        incrementPercentage: 40
    },
    {
        maxCost: 90,
        incrementPercentage: 30
    },
    {
        maxCost: Infinity,
        incrementPercentage: 25
    }
]


// la API nos devuelve la informacion sucia, la limpiamos con esta funcion

export async function transformToShopifyJSONL(
    sku: string,
    searchData: AstelavSearchResponse,
    stockData: AstelavStockResponse,
    datosPrevios?: { productId: string, variantId: string }
): Promise<string | null> {

    const infoSearch = searchData?.product_data?.[sku];
    const infoStock = stockData?.[sku];

    // 1. Descartar si falta información de alguno de los dos endpoints
    if (!infoSearch || !infoStock) return null;

    // 2. Filtro de venta y estado (Descarta descatalogados o no aptos para venta)
    if (infoSearch.for_sale !== true || infoSearch.life_cycle_status === 'cancelled') {
        return null;
    }

    // 3. Limpieza de stock ("25+" -> 25)
    const rawQuantity = infoStock.stock?.availableQuantity || 0;
    const cleanQuantity = typeof rawQuantity === 'string'
        ? parseInt(rawQuantity.replace(/\D/g, ''), 10) || 0
        : rawQuantity;

    // Descartar si el stock no es mayor que 0
    if (cleanQuantity <= 0) {
        return null;
    }

    // 4. Blindar el título para que nunca sea vacío
    const titleRaw = infoSearch.name || sku;
    const tituloSeguro = titleRaw.trim() !== "" ? titleRaw.trim() : `Repuesto ${sku}`;

    // 5. Blindar el handle haciéndolo 100% único con el SKU
    const handleUnico = `${tituloSeguro}-${sku}`
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

    // Asegurar precio válido
    const precioBase = infoStock.price !== undefined && infoStock.price !== ""
        ? String(infoStock.price)
        : "0.00";
    const precioBaseFloat = parseFloat(precioBase);

    const rule = pricingRules.find(r => precioBaseFloat <= r.maxCost);
    const porcentaje = rule?.incrementPercentage ?? 0;
    const precioFinal = Math.ceil(precioBaseFloat * (1 + porcentaje / 100));
    const IVA = 0.21;
    const precioFinalConIVA = parseFloat((precioFinal * (1 + IVA)).toFixed(2));

    const shopifyPayload = {
        input: {

            // inyeccion de los datos previos
            ...(datosPrevios ? { id: datosPrevios.productId } : {}),

            handle: handleUnico,
            title: tituloSeguro,
            descriptionHtml: `
            <p><strong><font color="#ff0000" font-size="40px">Los envíos se realizan de 3 a 5 días hábiles </strong></font></strong></p><br>
            <p><strong>Descripci&oacute;n:</strong> ${infoSearch.description || tituloSeguro}</p><br>
            <p><strong>Marca:</strong> ${infoSearch.product_main_brand?.product_main_brand_name || 'N/A'}</p><br>
            <p><strong>C&oacute;digo original marca:</strong> ${infoSearch.product_brand_genuine_codes?.map(code => code.brand).join(', ') || 'N/A'} ${infoSearch.product_brand_genuine_codes?.map(code => code.brand_genuine_code).join(', ') || 'N/A'}</p><br>
            <p><strong>Marca Modelo</strong> ${infoSearch.appliance_main_brand_models || 'N/A'}</p><br>
            `,
            status: "ACTIVE",
            // Shopify exige declarar las opciones a nivel de producto
            productOptions: [
                {
                    name: "Title",
                    values: [{ name: "Default Title" }]
                }
            ],
            collections: [
                "gid://shopify/Collection/699687862659"
            ],
            // Adjuntar las imagenes si las hay
            //   ...(filesFormat.length > 0 ? { files: filesFormat } : {}),

            variants: [{
                // inyeccion de datos previos
                ...(datosPrevios ? { id: datosPrevios.variantId } : {}),
                sku: sku,
                price: String(precioFinalConIVA),
                // Shopify exige vincular la variante a una opción obligatoriamente
                optionValues: [{
                    optionName: "Title",
                    name: "Default Title"
                }],
                inventoryItem: { tracked: true },
                // El formato de inventario adaptado a ProductSetInventoryInput
                inventoryQuantities: [{
                    locationId: `gid://shopify/Location/${LOCATION_ID}`,
                    name: "available",
                    quantity: cleanQuantity
                }]
            }]
        }
    };

    return JSON.stringify(shopifyPayload);
}
// Procesamiento de los lotes de SKUs

export async function processSKUs(): Promise<BunFile> {
    const outputFile = Bun.file(`shopify_bulk_update_${new Date(Date.now()).toISOString()}.jsonl`);
    const writer = outputFile.writer();
    // Descargamos los datos existentes de shopify
    console.log("Descargando datos de Shopify");
    const productosExistentes = await obtenerMapaProductos();

    for await (const skusPage of getChangedSKUs()) {
        // Limpiamos duplicados
        const skusUnicos = [...new Set(skusPage)]
        // Lotes de 300 para exprimir la API de Astelav
        const batches = chunkBatch(skusUnicos, 300);
        console.log(`[DEBUG] Procesando lote de ${batches.length} SKUs`);
        for (const batch of batches) {
            try {
                // Ordenamos el lote para que los que necesiten imagenes vaya lo ultimo
                batch.sort((a, b) => {
                    const aExiste = productosExistentes.has(a);
                    const bExiste = productosExistentes.has(b);

                    if (aExiste && !bExiste) return -1; // a va primero
                    if (!aExiste && bExiste) return 1; // b va primero
                    return 0; // se queda igual
                })

                // Pedimos los precios y stock de los 300 SKUs
                const stockDataMassive = await getBatchStockData(batch as string[]);

                // Si la API falla masivamente, saltamos el lote para no escribir basura
                if (!stockDataMassive) continue;

                // Pedimos los detalles (textos) de forma concurrente para los 300
                const searchPromises = batch.map(sku => getProductDetails(sku as string));
                const searchDataArray = await Promise.all(searchPromises);

                // Cruzamos la información y escribimos en el JSONL
                for (let index = 0; index < batch.length; index++) {
                    const sku = batch[index];
                    const searchDetail = searchDataArray[index];
                    // Buscamos si el SKU ya esta
                    const datosExistentes = productosExistentes.get(sku);

                    const shopifyData = await transformToShopifyJSONL(
                        sku as string,
                        searchDetail as AstelavSearchResponse,
                        stockDataMassive as AstelavStockResponse,
                        datosExistentes
                    );

                    console.log(`[DEBUG] SKU: ${sku} details: ${JSON.stringify(searchDetail)}`);

                    if (shopifyData) {
                        writer.write(shopifyData + '\n');
                    } else {
                        // Debug opcional si un producto no tiene ambos datos
                        console.log(`[DEBUG] Datos incompletos para SKU: ${sku}`);
                    }
                }
            } catch (error) {
                console.error(`[${new Date(Date.now()).toISOString()}] Fallo al procesar lote: ${error}`);
            }
        }
        writer.flush();
    }
    writer.end();
    console.log(`[${new Date(Date.now()).toISOString()}] Proceso completado. Archivo generado: ${outputFile.name}`);
    return outputFile;
}

