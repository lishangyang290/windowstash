//! Platform adapters own the complete trusted record; business logic is shared.
use crate::{Result, State};
use serde::{Deserialize, Serialize};

pub trait StateStorage {
    fn load(&self) -> Result<State>;
    /// Must replace the entire record atomically, or return an error.
    fn save(&self, state: &State) -> Result<()>;
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u8,
    state: State,
}

pub fn encode(state: &State) -> Result<Vec<u8>> {
    serde_json::to_vec(&Record {
        schema: 1,
        state: state.clone(),
    })
    .map_err(|_| "corrupt_trusted_state")
}

pub fn decode(bytes: &[u8]) -> Result<State> {
    let record: Record = serde_json::from_slice(bytes).map_err(|_| "corrupt_trusted_state")?;
    if record.schema != 1 {
        return Err("unsupported_trusted_state");
    }
    Ok(record.state)
}

/// Deliberately vulnerable control for the original adversarial process test.
/// Never use this as a credential store. Absent from release executables.
#[cfg(any(test, all(debug_assertions, feature = "insecure-test-store")))]
pub struct InsecureTestStorage(pub std::path::PathBuf);

#[cfg(any(test, all(debug_assertions, feature = "insecure-test-store")))]
impl StateStorage for InsecureTestStorage {
    fn load(&self) -> Result<State> {
        use std::{fs, io::ErrorKind};
        let path = self.0.join("state.json");
        if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("unsafe_storage");
        }
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "corrupt_state"),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(State {
                invalidated: true,
                ..State::default()
            }),
            Err(_) => Err("storage_unavailable"),
        }
    }

    fn save(&self, state: &State) -> Result<()> {
        use std::fs;
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.0).map_err(|_| "storage_unavailable")?;
        serde_json::to_writer(&mut temporary, state).map_err(|_| "storage_unavailable")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "storage_unavailable")?;
        temporary
            .persist(self.0.join("state.json"))
            .map_err(|_| "storage_unavailable")?;
        fs::File::open(&self.0)
            .and_then(|dir| dir.sync_all())
            .map_err(|_| "storage_unavailable")
    }
}
