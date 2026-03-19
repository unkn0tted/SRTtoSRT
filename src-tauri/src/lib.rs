use std::{collections::HashMap, path::PathBuf, process::Command, time::Duration};

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionRequest {
    endpoint: String,
    api_key: Option<String>,
    payload: Value,
    extra_headers: Option<HashMap<String, String>>,
    timeout_secs: Option<u64>,
}

fn normalize_endpoint(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');

    if trimmed.is_empty() {
        return Err("API endpoint is empty.".into());
    }

    if trimmed.ends_with("/chat/completions") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{trimmed}/chat/completions"))
    }
}

fn truncate_for_error(message: &str, max_chars: usize) -> String {
    let mut buffer = String::new();

    for (idx, ch) in message.chars().enumerate() {
        if idx >= max_chars {
            buffer.push_str("...");
            break;
        }

        buffer.push(ch);
    }

    buffer
}

fn build_headers(request: &ChatCompletionRequest) -> Result<HeaderMap, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    if let Some(api_key) = request.api_key.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        let header_value = HeaderValue::from_str(&format!("Bearer {api_key}"))
            .map_err(|error| format!("Invalid Authorization header: {error}"))?;
        headers.insert(AUTHORIZATION, header_value);
    }

    if let Some(extra_headers) = &request.extra_headers {
        for (name, value) in extra_headers {
            if name.eq_ignore_ascii_case("authorization")
                && request
                    .api_key
                    .as_ref()
                    .map(|item| !item.trim().is_empty())
                    .unwrap_or(false)
            {
                continue;
            }

            let header_name =
                HeaderName::from_bytes(name.as_bytes()).map_err(|error| format!("Invalid header name `{name}`: {error}"))?;
            let header_value =
                HeaderValue::from_str(value).map_err(|error| format!("Invalid header value for `{name}`: {error}"))?;

            headers.insert(header_name, header_value);
        }
    }

    Ok(headers)
}

#[tauri::command]
async fn post_chat_completion(request: ChatCompletionRequest) -> Result<Value, String> {
    let endpoint = normalize_endpoint(&request.endpoint)?;
    let headers = build_headers(&request)?;
    let timeout = Duration::from_secs(request.timeout_secs.unwrap_or(90));

    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;

    let response = client
        .post(endpoint)
        .headers(headers)
        .json(&request.payload)
        .send()
        .await
        .map_err(|error| format!("HTTP request failed: {error}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|error| format!("Failed to read HTTP response: {error}"))?;

    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            truncate_for_error(&text, 800)
        ));
    }

    serde_json::from_str::<Value>(&text)
        .map_err(|_| format!("The API did not return JSON: {}", truncate_for_error(&text, 800)))
}

#[tauri::command]
fn open_directory(path: String) -> Result<(), String> {
    let trimmed = path.trim();

    if trimmed.is_empty() {
        return Err("数据目录尚未加载完成。".into());
    }

    let directory = PathBuf::from(trimmed);

    if !directory.exists() {
        return Err(format!("数据目录不存在：{}", directory.display()));
    }

    if !directory.is_dir() {
        return Err(format!("目标不是目录：{}", directory.display()));
    }

    let mut command = if cfg!(target_os = "windows") {
        let mut explorer = Command::new("explorer");
        explorer.arg(&directory);
        explorer
    } else if cfg!(target_os = "macos") {
        let mut open = Command::new("open");
        open.arg(&directory);
        open
    } else {
        let mut open = Command::new("xdg-open");
        open.arg(&directory);
        open
    };

    command
        .spawn()
        .map_err(|error| format!("打开数据目录失败：{error}"))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![post_chat_completion, open_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
