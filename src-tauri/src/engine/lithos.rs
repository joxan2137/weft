use serde::Deserialize;
use serde_json::{Map, Value, json};

pub const ID: &str = "lithosai";
pub const NAME: &str = "LithosAI";
pub const BASE_URL: &str = "https://api.lithosai.cloud/v1";

/// The models LithosAI documents on its pricing page; its `/models` list carries no limits or prices.
const CATALOG: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../src/engine/lithos.json"));

#[derive(Deserialize)]
struct Entry {
    id: String,
    name: String,
    context: u64,
    #[serde(rename = "maxOutput")]
    max_output: u64,
    input: Vec<String>,
    output: Vec<String>,
    #[serde(default)]
    reasoning: bool,
    #[serde(default)]
    variants: Vec<String>,
    cost: Cost,
}

#[derive(Deserialize)]
struct Cost {
    input: f64,
    output: f64,
    #[serde(rename = "cacheRead")]
    cache_read: f64,
}

/// The opencode config provider Weft adds to its own engine, so LithosAI is listed once it has a key.
pub fn provider() -> Option<Value> {
    let catalog: Vec<Entry> = serde_json::from_str(CATALOG).ok()?;
    let mut models = Map::new();
    for entry in catalog {
        let attachment = entry.input.iter().any(|item| item == "image" || item == "pdf");
        let variants = entry
            .variants
            .iter()
            .map(|variant| (variant.clone(), json!({ "reasoningEffort": variant })))
            .collect::<Map<String, Value>>();
        models.insert(
            entry.id.clone(),
            json!({
                "name": entry.name,
                "reasoning": entry.reasoning,
                "attachment": attachment,
                "tool_call": true,
                "modalities": { "input": entry.input, "output": entry.output },
                "options": if variants.is_empty() { json!({}) } else { json!({ "reasoningEffort": "high" }) },
                "variants": variants,
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
    fn carries_the_documented_catalog() {
        let provider = provider().unwrap();
        assert_eq!(provider["name"], NAME);
        assert_eq!(provider["options"]["baseURL"], BASE_URL);
        let models = provider["models"].as_object().unwrap();
        assert!(models.len() >= 6);
        for model in models.values() {
            assert_eq!(model["limit"]["context"], 1_048_576);
            assert!(model["cost"]["input"].is_number());
            assert_eq!(model["variants"]["high"]["reasoningEffort"], "high");
        }
        assert_eq!(models["moonshotai/Kimi-K3-fast"]["name"], "Kimi K3 fast");
    }
}
