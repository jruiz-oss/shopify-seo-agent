import { config } from "../config.js";

const endpoint = `https://${config.shopify.domain}/admin/api/${config.shopify.apiVersion}/graphql.json`;

export async function gql<T = any>(query: string, variables: Record<string, any> = {}): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.shopify.token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 2000));
    return gql(query, variables);
  }
  const json: any = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  // throttle: back off when close to the bucket limit
  const cost = json.extensions?.cost;
  if (cost && cost.throttleStatus.currentlyAvailable < cost.requestedQueryCost * 2) {
    await new Promise((r) => setTimeout(r, 1500));
  }
  return json.data as T;
}

export type ShopifyResource = {
  targetType: "product" | "collection" | "page" | "article";
  id: string;
  handle: string;
  title: string;
  url: string;
  seoTitle: string | null;
  seoDescription: string | null;
  bodyHtml: string | null;
  status?: string;
  productType?: string;
  tags?: string[];
  images?: { id: string; alt: string | null; url: string }[];
  updatedAt: string;
  blogHandle?: string;
  seoMetafieldIds?: { title?: string; description?: string };
};

async function paginate<T>(fetchPage: (cursor: string | null) => Promise<{ nodes: T[]; hasNext: boolean; cursor: string | null }>): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  while (true) {
    const { nodes, hasNext, cursor: next } = await fetchPage(cursor);
    out.push(...nodes);
    if (!hasNext) break;
    cursor = next;
  }
  return out;
}

export async function fetchProducts(): Promise<ShopifyResource[]> {
  const nodes = await paginate<any>(async (cursor) => {
    const d = await gql(
      `query($cursor: String) {
        products(first: 100, after: $cursor, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes {
            id handle title status productType tags updatedAt descriptionHtml
            seo { title description }
            onlineStoreUrl
            media(first: 20) { nodes { id alt ... on MediaImage { image { url } } } }
          }
        }
      }`,
      { cursor },
    );
    return { nodes: d.products.nodes, hasNext: d.products.pageInfo.hasNextPage, cursor: d.products.pageInfo.endCursor };
  });
  return nodes.map((p) => ({
    targetType: "product",
    id: p.id,
    handle: p.handle,
    title: p.title,
    url: p.onlineStoreUrl ?? `${config.siteUrl}/products/${p.handle}`,
    seoTitle: p.seo?.title || null,
    seoDescription: p.seo?.description || null,
    bodyHtml: p.descriptionHtml ?? null,
    status: p.status,
    productType: p.productType,
    tags: p.tags,
    images: (p.media?.nodes ?? []).filter((m: any) => m.image).map((m: any) => ({ id: m.id, alt: m.alt || null, url: m.image.url })),
    updatedAt: p.updatedAt,
  }));
}

export async function fetchCollections(): Promise<ShopifyResource[]> {
  const nodes = await paginate<any>(async (cursor) => {
    const d = await gql(
      `query($cursor: String) {
        collections(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title updatedAt descriptionHtml seo { title description } productsCount { count } }
        }
      }`,
      { cursor },
    );
    return { nodes: d.collections.nodes, hasNext: d.collections.pageInfo.hasNextPage, cursor: d.collections.pageInfo.endCursor };
  });
  return nodes.map((c) => ({
    targetType: "collection",
    id: c.id,
    handle: c.handle,
    title: c.title,
    url: `${config.siteUrl}/collections/${c.handle}`,
    seoTitle: c.seo?.title || null,
    seoDescription: c.seo?.description || null,
    bodyHtml: c.descriptionHtml ?? null,
    updatedAt: c.updatedAt,
  }));
}

const seoMetafieldsFragment = `
  seoTitleMf: metafield(namespace: "global", key: "title_tag") { id value }
  seoDescMf: metafield(namespace: "global", key: "description_tag") { id value }
`;

export async function fetchPages(): Promise<ShopifyResource[]> {
  const nodes = await paginate<any>(async (cursor) => {
    const d = await gql(
      `query($cursor: String) {
        pages(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title body updatedAt isPublished ${seoMetafieldsFragment} }
        }
      }`,
      { cursor },
    );
    return { nodes: d.pages.nodes, hasNext: d.pages.pageInfo.hasNextPage, cursor: d.pages.pageInfo.endCursor };
  });
  return nodes
    .filter((p) => p.isPublished)
    .map((p) => ({
      targetType: "page",
      id: p.id,
      handle: p.handle,
      title: p.title,
      url: `${config.siteUrl}/pages/${p.handle}`,
      seoTitle: p.seoTitleMf?.value || null,
      seoDescription: p.seoDescMf?.value || null,
      bodyHtml: p.body ?? null,
      updatedAt: p.updatedAt,
      seoMetafieldIds: { title: p.seoTitleMf?.id, description: p.seoDescMf?.id },
    }));
}

export async function fetchArticles(): Promise<ShopifyResource[]> {
  const nodes = await paginate<any>(async (cursor) => {
    const d = await gql(
      `query($cursor: String) {
        articles(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id handle title body updatedAt isPublished blog { handle } ${seoMetafieldsFragment} }
        }
      }`,
      { cursor },
    );
    return { nodes: d.articles.nodes, hasNext: d.articles.pageInfo.hasNextPage, cursor: d.articles.pageInfo.endCursor };
  });
  return nodes
    .filter((a) => a.isPublished)
    .map((a) => ({
      targetType: "article",
      id: a.id,
      handle: a.handle,
      title: a.title,
      url: `${config.siteUrl}/blogs/${a.blog.handle}/${a.handle}`,
      seoTitle: a.seoTitleMf?.value || null,
      seoDescription: a.seoDescMf?.value || null,
      bodyHtml: a.body ?? null,
      updatedAt: a.updatedAt,
      blogHandle: a.blog.handle,
      seoMetafieldIds: { title: a.seoTitleMf?.id, description: a.seoDescMf?.id },
    }));
}

export async function fetchRedirects(): Promise<{ id: string; path: string; target: string }[]> {
  return paginate<any>(async (cursor) => {
    const d = await gql(
      `query($cursor: String) {
        urlRedirects(first: 250, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id path target }
        }
      }`,
      { cursor },
    );
    return { nodes: d.urlRedirects.nodes, hasNext: d.urlRedirects.pageInfo.hasNextPage, cursor: d.urlRedirects.pageInfo.endCursor };
  });
}

export async function fetchAll(): Promise<ShopifyResource[]> {
  const [p, c, pg, a] = await Promise.all([fetchProducts(), fetchCollections(), fetchPages(), fetchArticles()]);
  return [...p, ...c, ...pg, ...a];
}

// ---------- writes ----------

function userErrors(payload: any) {
  const errs = payload?.userErrors ?? [];
  if (errs.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errs)}`);
}

export async function updateSeo(targetType: string, id: string, field: "title" | "description", value: string) {
  if (targetType === "product") {
    const d = await gql(
      `mutation($id: ID!, $product: ProductUpdateInput!) {
        productUpdate(identifier: { id: $id }, product: $product) { product { id } userErrors { field message } }
      }`,
      { id, product: { seo: { [field]: value } } },
    );
    userErrors(d.productUpdate);
    return;
  }
  if (targetType === "collection") {
    const d = await gql(
      `mutation($input: CollectionInput!) {
        collectionUpdate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: { id, seo: { [field]: value } } },
    );
    userErrors(d.collectionUpdate);
    return;
  }
  // pages and articles: global.title_tag / global.description_tag metafields
  const key = field === "title" ? "title_tag" : "description_tag";
  const metafield = { namespace: "global", key, value, type: "single_line_text_field" };
  if (targetType === "page") {
    const d = await gql(
      `mutation($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } }
      }`,
      { id, page: { metafields: [metafield] } },
    );
    userErrors(d.pageUpdate);
    return;
  }
  if (targetType === "article") {
    const d = await gql(
      `mutation($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } }
      }`,
      { id, article: { metafields: [metafield] } },
    );
    userErrors(d.articleUpdate);
    return;
  }
  throw new Error(`updateSeo: unsupported target ${targetType}`);
}

export async function updateBody(targetType: string, id: string, html: string) {
  if (targetType === "product") {
    const d = await gql(
      `mutation($id: ID!, $product: ProductUpdateInput!) {
        productUpdate(identifier: { id: $id }, product: $product) { product { id } userErrors { field message } }
      }`,
      { id, product: { descriptionHtml: html } },
    );
    userErrors(d.productUpdate);
    return;
  }
  if (targetType === "collection") {
    const d = await gql(
      `mutation($input: CollectionInput!) {
        collectionUpdate(input: $input) { collection { id } userErrors { field message } }
      }`,
      { input: { id, descriptionHtml: html } },
    );
    userErrors(d.collectionUpdate);
    return;
  }
  if (targetType === "page") {
    const d = await gql(
      `mutation($id: ID!, $page: PageUpdateInput!) {
        pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } }
      }`,
      { id, page: { body: html } },
    );
    userErrors(d.pageUpdate);
    return;
  }
  if (targetType === "article") {
    const d = await gql(
      `mutation($id: ID!, $article: ArticleUpdateInput!) {
        articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } }
      }`,
      { id, article: { body: html } },
    );
    userErrors(d.articleUpdate);
    return;
  }
  throw new Error(`updateBody: unsupported target ${targetType}`);
}

export async function updateMediaAlt(productId: string, mediaId: string, alt: string) {
  const d = await gql(
    `mutation($productId: ID!, $media: [UpdateMediaInput!]!) {
      productUpdateMedia(productId: $productId, media: $media) { media { id alt } mediaUserErrors { field message } }
    }`,
    { productId, media: [{ id: mediaId, alt }] },
  );
  const errs = d.productUpdateMedia?.mediaUserErrors ?? [];
  if (errs.length) throw new Error(`Shopify mediaUserErrors: ${JSON.stringify(errs)}`);
}

export async function createRedirect(path: string, target: string): Promise<string> {
  const d = await gql(
    `mutation($r: UrlRedirectInput!) {
      urlRedirectCreate(urlRedirect: $r) { urlRedirect { id } userErrors { field message } }
    }`,
    { r: { path, target } },
  );
  userErrors(d.urlRedirectCreate);
  return d.urlRedirectCreate.urlRedirect.id;
}

export async function deleteRedirect(id: string) {
  const d = await gql(
    `mutation($id: ID!) { urlRedirectDelete(id: $id) { deletedUrlRedirectId userErrors { field message } } }`,
    { id },
  );
  userErrors(d.urlRedirectDelete);
}

// seo.hidden = 1 adds noindex,nofollow. value "0" / delete removes it.
export async function setNoindex(targetType: string, id: string, hidden: boolean) {
  const metafield = { namespace: "seo", key: "hidden", value: hidden ? "1" : "0", type: "number_integer" };
  const map: Record<string, [string, string, string]> = {
    product: ["productUpdate", "identifier: { id: $id }, product: { metafields: $mf }", "ProductUpdate"],
  };
  if (targetType === "product") {
    const d = await gql(
      `mutation($id: ID!, $mf: [MetafieldInput!]) {
        productUpdate(identifier: { id: $id }, product: { metafields: $mf }) { product { id } userErrors { field message } }
      }`,
      { id, mf: [metafield] },
    );
    userErrors(d.productUpdate);
    return;
  }
  if (targetType === "collection") {
    const d = await gql(
      `mutation($input: CollectionInput!) { collectionUpdate(input: $input) { collection { id } userErrors { field message } } }`,
      { input: { id, metafields: [metafield] } },
    );
    userErrors(d.collectionUpdate);
    return;
  }
  if (targetType === "page") {
    const d = await gql(
      `mutation($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id } userErrors { field message } } }`,
      { id, page: { metafields: [metafield] } },
    );
    userErrors(d.pageUpdate);
    return;
  }
  if (targetType === "article") {
    const d = await gql(
      `mutation($id: ID!, $article: ArticleUpdateInput!) { articleUpdate(id: $id, article: $article) { article { id } userErrors { field message } } }`,
      { id, article: { metafields: [metafield] } },
    );
    userErrors(d.articleUpdate);
    return;
  }
  void map;
  throw new Error(`setNoindex: unsupported target ${targetType}`);
}

// ---------- theme (read-only for context; writes are high-risk and go through approval) ----------

export async function getMainThemeId(): Promise<string> {
  const d = await gql(`{ themes(first: 1, roles: [MAIN]) { nodes { id name } } }`);
  return d.themes.nodes[0].id;
}

export async function readThemeFile(themeId: string, filename: string): Promise<string | null> {
  const d = await gql(
    `query($id: ID!, $files: [String!]!) {
      theme(id: $id) { files(filenames: $files, first: 1) { nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } } } }
    }`,
    { id: themeId, files: [filename] },
  );
  return d.theme?.files?.nodes?.[0]?.body?.content ?? null;
}

export async function upsertThemeFile(themeId: string, filename: string, content: string) {
  const d = await gql(
    `mutation($id: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
      themeFilesUpsert(themeId: $id, files: $files) { upsertedThemeFiles { filename } userErrors { field message } }
    }`,
    { id: themeId, files: [{ filename, body: { type: "TEXT", value: content } }] },
  );
  userErrors(d.themeFilesUpsert);
}
