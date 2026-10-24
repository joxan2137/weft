use serde::Deserialize;
use serde_json::{Map, Value, json};

pub const ID: &str = "opengateway";
pub const NAME: &str = "OpenGateway";
pub const BASE_URL: &str = "https://apis.opengateway.ai/v1";

/// `tools/sync-opengateway-models.mjs` rewrites the catalog from the gateway's public model list.
const CATALOG: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/engine/opengateway.json"));

#[derive(Deserialize)]
struct Entry {
    id: String,
    context: u64,
    #[serde(rename = "maxOutput")]
    max_output: u64,
    input: Vec<String>,
    output: Vec<String>,
    cost: Cost,
}

#[derive(Deserialize)]
struct Cost {
    input: f64,
    output: f64,
    #[serde(rename = "cacheRead")]
    cache_read: f64,
}

/// The opencode config provider Weft adds to its own engine, so OpenGateway is listed once it has a key.
pub fn provider() -> Option<Value> {
    let catalog: Vec<Entry> = serde_json::from_str(CATALOG).ok()?;
    let mut models = Map::new();
    for entry in catalog {
        let attachment = entry.input.iter().any(|item| item == "image" || item == "pdf");
        models.insert(
            entry.id.clone(),
            json!({
                "name": entry.id,
                "attachment": attachment,
                "tool_call": true,
                "modalities": { "input": entry.input, "output": entry.output },
                "limit": { "context": entry.context, "output": entry.max_output },
                "cost": {
                    "input": entry.cost.input,
                    "output": entry.cost.output,
                    "cache_read": entry.cost.cache_read,
                },
            }),
        );
    }
    if models.is_empty() {
        return None;
    }
    Some(json!({
        "name": NAME,
        "npm": "@ai-sdk/openai-compatible",
        "api": BASE_URL,
        "options": { "baseURL": BASE_URL },
        "models": models,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn carries_the_whole_chat_catalog() {
        let provider = provider().unwrap();
        assert_eq!(provider["name"], NAME);
        assert_eq!(provider["options"]["baseURL"], BASE_URL);
        let models = provider["models"].as_object().unwrap();
        assert!(models.len() > 10);
        for (id, model) in models {
            assert_eq!(model["name"], id.as_str());
            assert!(model["cost"]["input"].is_number());
            assert!(model["limit"]["context"].is_number());
        }
    }
}
