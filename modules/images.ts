import { graphql } from "./functions";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function processAstelavImages(sku: string): Promise<string[]> {
    const CUSTOMER_ID = process.env.ASTELAV_CUSTOMER_ID;
    const token = (process.env.environment! == "TEST") ? process.env.ASTELAV_TEST_API_TOKEN : process.env.ASTELAV_LIVE_API_TOKEN;

    if (!CUSTOMER_ID || !token) throw new Error("No se encuentra el customer ID o el token");

    // Consultar la lista de imagenes del producto
    // 
    const listUrl = `https://${(process.env.environment! == "TEST") ? "stagingapi" : "api"}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/productImages/${sku}?token=${token}`;

    try {
        const response = await fetch(listUrl);
        if (!response.ok) throw new Error(`Error al obtener la lista de imagenes: ${response.statusText}`);

        const data: any = await response.json();
        if (!data.ProductImages || data.ProductImages.length === 0) return [];

        const imageUrls: string[] = [];

        for (const img of data.ProductImages) {
            const imgName: string = img.ImageName;
            // Comprobacion de parametros previos de la imagen
            const separator = img.ImageUrl.includes("?") ? "&" : "?";

            const downloadUrl = `${img.ImageUrl}${separator}token=${token}`;

            // Descargar a la ram
            const imgRes = await fetch(downloadUrl);
            if (!imgRes.ok) continue;

            const arrayBuffer = await imgRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Subir a shopify
            const queryStaged = `
                mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
                    stagedUploadsCreate(input: $input) {
                        stagedTargets {
                            url
                            resourceUrl
                            parameters { name value }
                        }
                    }
                }
            `;

            const stagedData = await graphql(queryStaged, {
                input: [{
                    filename: imgName,
                    mimeType: "image/jpeg",
                    resource: "IMAGE",
                    fileSize: buffer.length.toString(),
                    httpMethod: "PUT"
                }]
            });

            const target = stagedData.stagedUploadsCreate.stagedTargets[0];
            console.log("target parameters:", target.parameters)
            // Subida fisica
            console.log("target.url:", target.url)
            const uploadResponse = await fetch(target.url, {
                method: 'PUT',
                headers: {
                    'Content-type': 'image/jpeg',
                    'Content-Length': buffer.length.toString()
                },
                body: buffer
            });
            if (!uploadResponse.ok) throw new Error(`Error al subir la imagen ${await uploadResponse.text()}`);

            console.log("imagen subida correctamente");

            imageUrls.push(target.resourceUrl);
            await delay(1000)
        }

        return imageUrls;

    } catch (error) {
        console.error(`Error al obtener la lista de imagenes: ${error}`);
        return [];
    }

}



// Sobrecarga para que pueda recibir una id, esto es para productos ya existentes


export async function processAstelavImagesForExistingProduct(sku: string, productId: string): Promise<boolean> {
    const CUSTOMER_ID = process.env.ASTELAV_CUSTOMER_ID;
    const token = (process.env.environment! == "TEST") ? process.env.ASTELAV_TEST_API_TOKEN : process.env.ASTELAV_LIVE_API_TOKEN;

    if (!CUSTOMER_ID || !token) throw new Error("No se encuentra el customer ID o el token");

    const listUrl = `https://${(process.env.environment! == "TEST") ? "stagingapi" : "api"}.astelav.com/apicustomers/v2/${CUSTOMER_ID}/productImages/${sku}?token=${token}`;

    try {
        const response = await fetch(listUrl);
        if (!response.ok) throw new Error(`Error al obtener la lista de imagenes: ${response.statusText}`);

        const data: any = await response.json();
        if (!data.ProductImages || data.ProductImages.length === 0) return false;

        const imageUrls: string[] = [];

        for (const img of data.ProductImages) {
            const imgName: string = img.ImageName;
            const separator = img.ImageUrl.includes("?") ? "&" : "?";
            const downloadUrl = `${img.ImageUrl}${separator}token=${token}`;

            // Descargar a la ram
            const imgRes = await fetch(downloadUrl);
            if (!imgRes.ok) continue;

            const arrayBuffer = await imgRes.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            // Subir a shopify (Staging)
            const queryStaged = `
                mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
                    stagedUploadsCreate(input: $input) {
                        stagedTargets {
                            url
                            resourceUrl
                            parameters { name value }
                        }
                    }
                }
            `;

            const stagedData = await graphql(queryStaged, {
                input: [{
                    filename: imgName,
                    mimeType: "image/jpeg",
                    resource: "IMAGE",
                    fileSize: buffer.length.toString(),
                    httpMethod: "PUT"
                }]
            });

            const target = stagedData.stagedUploadsCreate.stagedTargets[0];

            // Subida fisica
            const uploadResponse = await fetch(target.url, {
                method: 'PUT',
                headers: {
                    'Content-type': 'image/jpeg',
                    'Content-Length': buffer.length.toString()
                },
                body: buffer
            });

            if (!uploadResponse.ok) throw new Error(`Error al subir la imagen ${await uploadResponse.text()}`);

            imageUrls.push(target.resourceUrl);
            await delay(1000); // Respetar rate limit Astelav
        }

        // Adjuntar las imágenes al producto
        if (imageUrls.length > 0) {
            const mediaInput = imageUrls.map(url => ({
                alt: sku,
                mediaContentType: "IMAGE",
                originalSource: url
            }));

            const mutationMedia = `
                mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
                    productCreateMedia(media: $media, productId: $productId) {
                        media {
                            status
                        }
                        mediaUserErrors {
                            field
                            message
                        }
                    }
                }
            `;

            const mediaData = await graphql(mutationMedia, {
                media: mediaInput,
                productId: productId
            });

            const errors = mediaData.productCreateMedia?.mediaUserErrors;
            if (errors && errors.length > 0) {
                console.error(`Errores adjuntando imágenes al producto ${sku}:`, errors);
                return false;
            }

            console.log(`${imageUrls.length} imágenes adjuntadas al producto ${sku}`);
        }

        return true;

    } catch (error) {
        console.error(`Error procesando imágenes para ${sku}: ${error}`);
        return false;
    }
}