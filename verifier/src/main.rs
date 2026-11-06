//! Verification core for the Cross-Chain Transaction Relay Gateway.
//!
//! Stateless and CPU-bound by design: the Node.js gateway sends batches of
//! (publicKey, message, signature) triples; we verify Ed25519 signatures in
//! parallel with rayon and return the SHA-256 digest of each valid message,
//! which the gateway uses as the relay request's canonical ID.

use axum::{extract::DefaultBodyLimit, http::StatusCode, routing::{get, post}, Json, Router};
use ed25519_dalek::{Signature, VerifyingKey};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MAX_BATCH: usize = 1000;

#[derive(Deserialize)]
struct Item {
    id: String,
    #[serde(rename = "publicKey")]
    public_key: String, // hex, 32 bytes
    message: String,    // hex, arbitrary length
    signature: String,  // hex, 64 bytes
}

#[derive(Deserialize)]
struct Batch {
    items: Vec<Item>,
}

#[derive(Serialize, Debug, PartialEq)]
struct ItemResult {
    id: String,
    valid: bool,
    digest: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct BatchResult {
    results: Vec<ItemResult>,
}

fn decode_fixed<const N: usize>(field: &str, s: &str) -> Result<[u8; N], String> {
    let bytes = hex::decode(s).map_err(|_| format!("{field}: invalid hex"))?;
    bytes.try_into().map_err(|_| format!("{field}: must be {N} bytes"))
}

fn verify_one(it: &Item) -> ItemResult {
    let outcome = (|| -> Result<String, String> {
        let pk: [u8; 32] = decode_fixed("publicKey", &it.public_key)?;
        let sig: [u8; 64] = decode_fixed("signature", &it.signature)?;
        let msg = hex::decode(&it.message).map_err(|_| "message: invalid hex".to_string())?;
        let vk = VerifyingKey::from_bytes(&pk).map_err(|_| "publicKey: invalid point".to_string())?;
        // verify_strict rejects malleable / small-order signatures.
        vk.verify_strict(&msg, &Signature::from_bytes(&sig))
            .map_err(|_| "signature mismatch".to_string())?;
        Ok(hex::encode(Sha256::digest(&msg)))
    })();
    match outcome {
        Ok(d) => ItemResult { id: it.id.clone(), valid: true, digest: Some(d), error: None },
        Err(e) => ItemResult { id: it.id.clone(), valid: false, digest: None, error: Some(e) },
    }
}

async fn verify(Json(batch): Json<Batch>) -> Result<Json<BatchResult>, (StatusCode, String)> {
    if batch.items.len() > MAX_BATCH {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, format!("max batch is {MAX_BATCH}")));
    }
    // CPU-bound: keep it off the async executor threads.
    let results = tokio::task::spawn_blocking(move || batch.items.par_iter().map(verify_one).collect())
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(BatchResult { results }))
}

fn app() -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/verify", post(verify))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}

#[tokio::main]
async fn main() {
    let addr = std::env::var("VERIFIER_ADDR").unwrap_or_else(|_| "0.0.0.0:7001".into());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("relay-verifier listening on {addr}");
    axum::serve(listener, app())
        .with_graceful_shutdown(async { let _ = tokio::signal::ctrl_c().await; })
        .await
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn signed(msg: &[u8]) -> Item {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        Item {
            id: "1".into(),
            public_key: hex::encode(sk.verifying_key().to_bytes()),
            message: hex::encode(msg),
            signature: hex::encode(sk.sign(msg).to_bytes()),
        }
    }

    #[test]
    fn accepts_valid_signature_and_returns_digest() {
        let r = verify_one(&signed(b"hello"));
        assert!(r.valid);
        assert_eq!(r.digest.unwrap(), hex::encode(Sha256::digest(b"hello")));
    }

    #[test]
    fn rejects_tampered_message() {
        let mut it = signed(b"hello");
        it.message = hex::encode(b"hellp");
        assert_eq!(verify_one(&it).error.as_deref(), Some("signature mismatch"));
    }

    #[test]
    fn rejects_malformed_input() {
        let mut it = signed(b"hello");
        it.signature = "zz".into();
        assert!(!verify_one(&it).valid);
        it.signature = "00".into();
        assert_eq!(verify_one(&it).error.as_deref(), Some("signature: must be 64 bytes"));
    }
}
