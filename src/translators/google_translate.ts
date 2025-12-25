const DEFAULT_TRANSLATE_ENDPOINT =
    "https://translate.googleapis.com/translate_a/single";

const TRANSLATE_ENDPOINT_CONF_URL =
    "https://translate-endpoint-conf.tako01.xyz/?key=kc6k97bbituuz57n";

let cachedTranslateEndpoint: string | null = null;
let translateEndpointInitPromise: Promise<string> | null = null;

function tryParseEndpointFromResponseBody(body: string): string | null {
    const trimmed = body.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (typeof parsed === "string") return parsed.trim();
            if (parsed && typeof parsed === "object") {
                const obj = parsed as Record<string, unknown>;
                const candidate =
                    (typeof obj.url === "string" && obj.url) ||
                    (typeof obj.endpoint === "string" && obj.endpoint) ||
                    (typeof obj.base_url === "string" && obj.base_url) ||
                    (typeof obj.baseUrl === "string" && obj.baseUrl) ||
                    null;
                return candidate ? candidate.trim() : null;
            }
        } catch {
            return null;
        }
    }

    return trimmed;
}

export async function initGoogleTranslateEndpoint(): Promise<string> {
    if (cachedTranslateEndpoint) return cachedTranslateEndpoint;
    if (!translateEndpointInitPromise) {
        translateEndpointInitPromise = (async () => {
            try {
                const resp = await fetch(TRANSLATE_ENDPOINT_CONF_URL, {
                    cache: "no-store",
                });

                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

                const body = await resp.text();
                const endpoint = tryParseEndpointFromResponseBody(body);
                if (!endpoint) throw new Error("empty endpoint");

                // Validate URL early to avoid surprising failures later
                // (also normalizes things like trailing spaces)
                cachedTranslateEndpoint = new URL(endpoint).toString();
                return cachedTranslateEndpoint;
            } catch {
                cachedTranslateEndpoint = DEFAULT_TRANSLATE_ENDPOINT;
                return cachedTranslateEndpoint;
            }
        })();
    }

    return translateEndpointInitPromise;
}

export default async function translateGT(
    text: string,
    source: string,
    target: string,
) {
    const baseEndpoint = await initGoogleTranslateEndpoint();

    const url = new URL(baseEndpoint);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", source);
    url.searchParams.set("tl", target);
    url.searchParams.set("dt", "t");
    url.searchParams.set("dj", "1");
    url.searchParams.set("q", text);

    const res = await (await fetch(url.toString())).json();

    let final = "";
    final = unescape(res.sentences[0].trans);
    for (let i = 1; i < res.sentences.length; i++) {
        final += " " + unescape(res.sentences[i].trans);
    }

    return final;
}