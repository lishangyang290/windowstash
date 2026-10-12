//! Native status and browser authorization, with a single refresh owner.
use fs2::FileExt;
use p256::ecdsa::{signature::Verifier, Signature, VerifyingKey};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
};

pub const VERSION: u8 = 1;
pub const MAX_FRAME: usize = 64 * 1024;
pub type Result<T> = std::result::Result<T, &'static str>;

#[cfg(all(feature = "insecure-test-store", not(debug_assertions)))]
compile_error!("insecure-test-store is forbidden in production builds");

pub mod auth;
pub mod bridge;
pub mod storage;
use storage::StateStorage;

pub fn random_id() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    hex(&bytes)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 || !value.is_ascii() {
        return Err("invalid_encoding");
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| "invalid_encoding"))
        .collect()
}

pub fn valid_origin(value: &str) -> bool {
    value
        .strip_prefix("chrome-extension://")
        .and_then(|id| id.strip_suffix('/'))
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub origin: String,
    pub public_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Pairing {
    pub id: String,
    pub profile: Profile,
    pub expires_at: u64,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub revision: u64,
    pub pairing: Option<Pairing>,
    pub owner: Option<Profile>,
    pub generation: String,
    pub last_sequence: u64,
    // A tombstone survives Companion/Chrome restarts. It is not a Session.
    pub invalidated: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Snapshot,
    Invalidate { reason: InvalidationReason },
    Unpair,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidationReason {
    Logout,
    AccountChanged,
    ProjectChanged,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub version: u8,
    pub challenge: String,
    pub profile_id: String,
    pub generation: String,
    pub sequence: u64,
    pub expected_revision: u64,
    pub operation: Operation,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedCommand {
    pub payload: String,
    pub signature: String,
}

/// The native Host and future Companion adapter use the same locked ledger.
/// Approval is exposed only to the desktop adapter, never as a wire command.
pub struct Store<B: StateStorage> {
    pub directory: PathBuf,
    backend: B,
}

impl<B: StateStorage> Store<B> {
    pub fn new(directory: PathBuf, backend: B) -> Self {
        Self { directory, backend }
    }

    fn transact<T>(&self, operation: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        fs::create_dir_all(&self.directory).map_err(|_| "storage_unavailable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if fs::symlink_metadata(&self.directory)
                .map_err(|_| "storage_unavailable")?
                .file_type()
                .is_symlink()
            {
                return Err("unsafe_storage");
            }
            fs::set_permissions(&self.directory, fs::Permissions::from_mode(0o700))
                .map_err(|_| "storage_unavailable")?;
        }
        #[cfg(not(unix))]
        return Err("platform_storage_not_configured");

        let lock_path = self.directory.join("state.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("unsafe_storage");
        }
        let mut options = fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lock = options.open(lock_path).map_err(|_| "storage_unavailable")?;
        lock.lock_exclusive().map_err(|_| "storage_unavailable")?;
        // The protected backend is authoritative for BOTH identity and latest
        // state. No on-disk ledger may supply a key, generation or tombstone.
        let mut state = self.backend.load()?;
        let previous = state.clone();
        let result = operation(&mut state)?;
        if state != previous {
            self.backend.save(&state)?;
        }
        Ok(result)
    }

    pub fn snapshot(&self) -> Result<State> {
        self.transact(|state| Ok(state.clone()))
    }

    pub fn request_pairing(&self, profile: Profile, now: u64) -> Result<Pairing> {
        if profile.id.len() != 64 || unhex(&profile.id).is_err() || !valid_origin(&profile.origin) {
            return Err("invalid_profile");
        }
        VerifyingKey::from_sec1_bytes(&unhex(&profile.public_key)?).map_err(|_| "invalid_key")?;
        self.transact(|state| {
            if state.owner.is_some() {
                return Err("already_paired");
            }
            if state
                .pairing
                .as_ref()
                .is_some_and(|pending| pending.expires_at > now)
            {
                return Err("pairing_pending");
            }
            let id = random_id();
            let fingerprint = hex(&Sha256::digest(format!(
                "windowstash-pair-v1\n{id}\n{}\n{}\n{}",
                profile.id, profile.origin, profile.public_key
            )));
            let pairing = Pairing {
                id,
                profile,
                expires_at: now.checked_add(120).ok_or("invalid_clock")?,
                fingerprint,
            };
            state.pairing = Some(pairing.clone());
            Ok(pairing)
        })
    }

    /// Called by an explicit desktop confirmation after comparing fingerprints.
    pub fn approve_pairing(&self, id: &str, fingerprint: &str, now: u64) -> Result<State> {
        self.transact(|state| {
            if state.owner.is_some() {
                return Err("already_paired");
            }
            let pending = state.pairing.as_ref().ok_or("no_pairing")?;
            if pending.id != id || pending.fingerprint != fingerprint || pending.expires_at <= now {
                return Err("invalid_pairing_confirmation");
            }
            state.owner = Some(pending.profile.clone());
            state.pairing = None;
            state.generation = random_id();
            state.last_sequence = 0;
            state.revision = state.revision.checked_add(1).ok_or("revision_exhausted")?;
            state.invalidated = true;
            Ok(state.clone())
        })
    }

    pub fn apply(&self, signed: SignedCommand, origin: &str, challenge: &str) -> Result<State> {
        if signed.payload.len() > MAX_FRAME {
            return Err("oversized_payload");
        }
        let command: Command =
            serde_json::from_str(&signed.payload).map_err(|_| "invalid_command")?;
        if command.version != VERSION || command.challenge != challenge {
            return Err("invalid_challenge");
        }
        self.transact(|state| {
            let owner = state.owner.as_ref().ok_or("not_paired")?;
            if owner.origin != origin
                || owner.id != command.profile_id
                || command.generation != state.generation
            {
                return Err("wrong_profile");
            }
            let key = VerifyingKey::from_sec1_bytes(&unhex(&owner.public_key)?)
                .map_err(|_| "invalid_key")?;
            let signature = Signature::from_slice(&unhex(&signed.signature)?)
                .map_err(|_| "invalid_signature")?;
            key.verify(signed.payload.as_bytes(), &signature)
                .map_err(|_| "invalid_signature")?;
            if command.sequence
                != state
                    .last_sequence
                    .checked_add(1)
                    .ok_or("sequence_exhausted")?
            {
                return Err("replayed_command");
            }
            if command.expected_revision != state.revision {
                return Err("revision_conflict");
            }
            match command.operation {
                Operation::Snapshot => {}
                Operation::Invalidate { .. } => {
                    state.invalidated = true;
                    state.revision = state.revision.checked_add(1).ok_or("revision_exhausted")?;
                }
                Operation::Unpair => {
                    state.owner = None;
                    state.generation = random_id();
                    state.invalidated = true;
                    state.revision = state.revision.checked_add(1).ok_or("revision_exhausted")?;
                }
            }
            state.last_sequence = command.sequence;
            Ok(state.clone())
        })
    }
}

pub fn read_frame(reader: &mut impl Read) -> Result<Vec<u8>> {
    let mut length = [0; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| "incomplete_frame")?;
    let length = u32::from_ne_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err("invalid_frame_length");
    }
    let mut message = vec![0; length];
    reader
        .read_exact(&mut message)
        .map_err(|_| "incomplete_frame")?;
    Ok(message)
}

pub fn write_frame(writer: &mut impl Write, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| "invalid_response")?;
    if bytes.len() > MAX_FRAME {
        return Err("oversized_response");
    }
    writer
        .write_all(&(bytes.len() as u32).to_ne_bytes())
        .and_then(|_| writer.write_all(&bytes))
        .and_then(|_| writer.flush())
        .map_err(|_| "broken_pipe")
}

#[cfg(test)]
mod tests;
