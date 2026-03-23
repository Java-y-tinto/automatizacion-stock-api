// --- TIPOS PARA EL ENDPOINT DE BÚSQUEDA (TEXTOS) ---

export interface AstelavSearchResponse {
    results: number;
    iso_lang: string;
    query: string;
    product_data?: Record<string, AstelavProductDetails>; // Record nos permite usar el SKU dinámico como clave
    created_at: string;
    signature: string;
}

export interface AstelavProductDetails {
    appliance_main_brand_models?: string;
    sku: string;
    mpn: string;
    name: string;
    description?: string; // Opcional, a veces no viene
    product_type?: {
        product_type_id: string;
        product_type_label: string;
    };
    manufacturer_details?: {
        manufacturer: string;
        manufacturer_part_number: string;
    };
    product_brand_genuine_codes?: Array<{
        brand: string;
        brand_genuine_code: string;
    }>;
    product_category?: {
        product_category_id: string;
        product_category_name: string;
    };
    product_main_brand?: {
        product_main_brand_id: string;
        product_main_brand_name: string;
    };
    for_sale: boolean;
    life_cycle_status: string;
    alternative_products?: string[];
    appliances?: Array<{
        appliance_type_id: string;
        appliance_type_name: string;
    }>;
    appliance_brands?: Array<{
        appliance_brand_id: string;
        appliance_brand_name: string;
    }>;
}

// --- TIPOS PARA EL ENDPOINT DE PRODUCTOS (PRECIO Y STOCK) ---

// El POST masivo devuelve un objeto donde la clave es el SKU y el valor son los datos
export type AstelavStockResponse = Record<string, AstelavStockDetails>;

export interface AstelavStockDetails {
    sku: string;
    found: boolean;
    requestedQuantity: number;
    price: number | string; // Puede venir numérico o vacío
    stock?: {
        available: boolean;
        availability_date?: string;
        availableQuantity: string | number; // A veces es "25+" y a veces número
        units_per_box?: number | boolean;
        units_per_pallet?: number | boolean;
        order_quantity_multiple?: number;
    };
    stock_per_order_type?: any; // Podemos dejarlo como any si no lo usamos

    description?: string;

    product_main_brand?: {
        product_main_brand_id: string;
        product_main_brand_name: string;
    };

    product_brand_genuine_codes?: Array<{
        brand: string;
        brand_genuine_code: string;
    }>;

    appliance_main_brand_models?: string;
}



export type ExcelRow = {
    SKU: string;
    MPN: string;
    product_type: string;   // OEM | Adaptable
    ProductName: string;
    BrandId: string;
    BrandDescription: string;
    settore: string;        // Washing, etc.
};

export type CSVRow = {
    id: string;
    title: string;
    price: string;
    sale_price: string;
    stock: string;
    image_link?: string;
    DESCRIPTION?: string;
    [key: string]: unknown;
};


export type PricingRule = {
    maxCost: number;
    incrementPercentage: number;

}

// types para leer el jsonl

type ProductOptionValue = {
    name: string;
};

type ProductOption = {
    name: string;
    values: ProductOptionValue[];
};

type VariantOptionValue = {
    optionName: string;
    name: string;
};

type InventoryItem = {
    tracked: boolean;
};

type InventoryQuantity = {
    locationId: string;
    name: string;
    quantity: number;
};

type ProductVariant = {
    sku: string;
    price: string;
    optionValues: VariantOptionValue[];
    inventoryItem: InventoryItem;
    inventoryQuantities: InventoryQuantity[];
};

type ShopifyProductInput = {
    handle: string;
    title: string;
    descriptionHtml: string;
    status: string; // Podría ser 'ACTIVE' | 'DRAFT' | 'ARCHIVED' si quieres afinar más
    productOptions: ProductOption[];
    collections: string[];
    variants: ProductVariant[];
};

export type JsonlLine = {
    input: ShopifyProductInput;
};