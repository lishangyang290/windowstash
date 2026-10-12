use super::*;
use crate::storage::InsecureTestStorage;
type TestStore = Store<InsecureTestStorage>;
fn test_store(path: PathBuf) -> TestStore {
    Store::new(path.clone(), InsecureTestStorage(path))
}
use p256::ecdsa::{signature::Signer, SigningKey};

const ORIGIN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

fn fixture() -> (tempfile::TempDir, TestStore, SigningKey, State) {
    let directory = tempfile::tempdir().unwrap();
    let store = test_store(directory.path().join("ledger"));
    let key = SigningKey::random(&mut OsRng);
    let profile = Profile {
        id: random_id(),
        origin: ORIGIN.into(),
        public_key: hex(key.verifying_key().to_encoded_point(false).as_bytes()),
    };
    let pairing = store.request_pairing(profile, 100).unwrap();
    let state = store
        .approve_pairing(&pairing.id, &pairing.fingerprint, 101)
        .unwrap();
    (directory, store, key, state)
}

fn signed(key: &SigningKey, state: &State, sequence: u64, operation: Operation) -> SignedCommand {
    let payload = serde_json::to_string(&Command {
        version: VERSION,
        challenge: "challenge".into(),
        profile_id: state.owner.as_ref().unwrap().id.clone(),
        generation: state.generation.clone(),
        sequence,
        expected_revision: state.revision,
        operation,
    })
    .unwrap();
    let signature: Signature = key.sign(payload.as_bytes());
    SignedCommand {
        payload,
        signature: hex(&signature.to_bytes()),
    }
}

#[test]
fn pairing_needs_explicit_matching_confirmation_and_expires() {
    let directory = tempfile::tempdir().unwrap();
    let store = test_store(directory.path().join("ledger"));
    let key = SigningKey::random(&mut OsRng);
    let profile = Profile {
        id: random_id(),
        origin: ORIGIN.into(),
        public_key: hex(key.verifying_key().to_encoded_point(false).as_bytes()),
    };
    let pending = store.request_pairing(profile.clone(), 100).unwrap();
    assert!(store.snapshot().unwrap().owner.is_none());
    assert_eq!(
        store.request_pairing(profile, 101).unwrap_err(),
        "pairing_pending"
    );
    assert_eq!(
        store
            .approve_pairing(&pending.id, "wrong", 101)
            .unwrap_err(),
        "invalid_pairing_confirmation"
    );
    assert_eq!(
        store
            .approve_pairing(&pending.id, &pending.fingerprint, 220)
            .unwrap_err(),
        "invalid_pairing_confirmation"
    );
}

#[test]
fn signatures_profiles_origins_and_challenges_are_checked() {
    let (_directory, store, key, state) = fixture();
    let attacker = SigningKey::random(&mut OsRng);
    assert_eq!(
        store
            .apply(
                signed(&attacker, &state, 1, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "invalid_signature"
    );
    assert_eq!(
        store
            .apply(
                signed(&key, &state, 1, Operation::Snapshot),
                "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/",
                "challenge"
            )
            .unwrap_err(),
        "wrong_profile"
    );
    assert_eq!(
        store
            .apply(
                signed(&key, &state, 1, Operation::Snapshot),
                ORIGIN,
                "new-challenge"
            )
            .unwrap_err(),
        "invalid_challenge"
    );
    let mut wrong_profile = state.clone();
    wrong_profile.owner.as_mut().unwrap().id = random_id();
    assert_eq!(
        store
            .apply(
                signed(&key, &wrong_profile, 1, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "wrong_profile"
    );
    assert_eq!(store.snapshot().unwrap().last_sequence, 0);
}

#[test]
fn logout_tombstone_and_sequence_survive_restart_and_replay() {
    let (directory, store, key, state) = fixture();
    let next = store
        .apply(
            signed(
                &key,
                &state,
                1,
                Operation::Invalidate {
                    reason: InvalidationReason::Logout,
                },
            ),
            ORIGIN,
            "challenge",
        )
        .unwrap();
    assert_eq!(next.revision, state.revision + 1);
    drop(store);
    let restarted = test_store(directory.path().join("ledger"));
    let restored = restarted.snapshot().unwrap();
    assert!(restored.invalidated);
    assert_eq!(restored.revision, next.revision);
    assert_eq!(
        restarted
            .apply(
                signed(&key, &restored, 1, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "replayed_command"
    );
}

#[test]
fn delayed_account_or_project_events_cannot_overwrite_newer_state() {
    let (_directory, store, key, state) = fixture();
    let next = store
        .apply(
            signed(
                &key,
                &state,
                1,
                Operation::Invalidate {
                    reason: InvalidationReason::AccountChanged,
                },
            ),
            ORIGIN,
            "challenge",
        )
        .unwrap();
    assert_eq!(
        store
            .apply(
                signed(
                    &key,
                    &state,
                    2,
                    Operation::Invalidate {
                        reason: InvalidationReason::ProjectChanged
                    }
                ),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "revision_conflict"
    );
    assert_eq!(store.snapshot().unwrap().revision, next.revision);
}

#[test]
fn unpair_revokes_old_profile_and_cannot_be_undone_by_replay() {
    let (_directory, store, key, state) = fixture();
    let next = store
        .apply(
            signed(&key, &state, 1, Operation::Unpair),
            ORIGIN,
            "challenge",
        )
        .unwrap();
    assert!(next.owner.is_none());
    assert!(next.invalidated);
    assert_ne!(next.generation, state.generation);
    assert_eq!(
        store
            .apply(
                signed(&key, &state, 2, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "not_paired"
    );
}

#[test]
fn concurrent_host_requests_have_one_winner() {
    let (_directory, store, key, state) = fixture();
    std::thread::scope(|scope| {
        let first = scope.spawn(|| {
            store.apply(
                signed(&key, &state, 1, Operation::Snapshot),
                ORIGIN,
                "challenge",
            )
        });
        let second = scope.spawn(|| {
            store.apply(
                signed(&key, &state, 1, Operation::Snapshot),
                ORIGIN,
                "challenge",
            )
        });
        assert_eq!(
            [first.join().unwrap(), second.join().unwrap()]
                .iter()
                .filter(|result| result.is_ok())
                .count(),
            1
        );
    });
}

#[test]
fn corrupt_storage_fails_closed_without_replacing_it() {
    let (_directory, store, _key, _state) = fixture();
    fs::write(store.directory.join("state.json"), b"broken").unwrap();
    assert_eq!(store.snapshot().unwrap_err(), "corrupt_state");
    assert_eq!(
        fs::read(store.directory.join("state.json")).unwrap(),
        b"broken"
    );
}

#[test]
fn frames_are_bounded_and_truncation_is_rejected() {
    let mut output = Vec::new();
    write_frame(&mut output, &serde_json::json!({"version": VERSION})).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&read_frame(&mut output.as_slice()).unwrap())
            .unwrap()["version"],
        VERSION
    );
    assert_eq!(
        read_frame(&mut ((MAX_FRAME + 1) as u32).to_ne_bytes().as_slice()).unwrap_err(),
        "invalid_frame_length"
    );
    assert_eq!(
        read_frame(&mut [4, 0, 0, 0, 1].as_slice()).unwrap_err(),
        "incomplete_frame"
    );
}

#[test]
fn unknown_fields_and_credential_payloads_are_rejected() {
    let (_directory, store, key, state) = fixture();
    let mut message = signed(&key, &state, 1, Operation::Snapshot);
    let mut payload: serde_json::Value = serde_json::from_str(&message.payload).unwrap();
    payload["refresh_token"] = "must-not-be-accepted".into();
    message.payload = payload.to_string();
    assert_eq!(
        store.apply(message, ORIGIN, "challenge").unwrap_err(),
        "invalid_command"
    );
}

#[cfg(unix)]
#[test]
fn ledger_is_private_and_symlinks_are_rejected() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let (directory, store, _key, _state) = fixture();
    assert_eq!(
        fs::metadata(&store.directory).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(store.directory.join("state.json"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let alias = directory.path().join("alias");
    symlink(&store.directory, &alias).unwrap();
    assert_eq!(test_store(alias).snapshot().unwrap_err(), "unsafe_storage");
}

// These tests simulate the OS access boundary with memory; they are not system
// secure-storage acceptance tests. The attacker still has arbitrary ledger file access.
#[derive(Clone)]
struct ProtectedMemory(std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>);

impl StateStorage for ProtectedMemory {
    fn load(&self) -> Result<State> {
        storage::decode(
            self.0
                .lock()
                .unwrap()
                .as_deref()
                .ok_or("trusted_state_missing")?,
        )
    }

    fn save(&self, state: &State) -> Result<()> {
        let mut record = self.0.lock().unwrap();
        if record.is_none() {
            return Err("trusted_state_missing");
        }
        *record = Some(storage::encode(state)?);
        Ok(())
    }
}

fn protected_fixture() -> (
    tempfile::TempDir,
    Store<ProtectedMemory>,
    SigningKey,
    State,
    ProtectedMemory,
) {
    let (directory, _legacy, key, state) = fixture();
    let backend = ProtectedMemory(std::sync::Arc::new(std::sync::Mutex::new(Some(
        storage::encode(&state).unwrap(),
    ))));
    let store = Store::new(directory.path().join("protected"), backend.clone());
    (directory, store, key, state, backend)
}

#[test]
fn ledger_key_replacement_cannot_change_the_protected_owner() {
    let (_directory, store, key, state, _backend) = protected_fixture();
    let attacker = SigningKey::random(&mut OsRng);
    let mut forged = state.clone();
    forged.owner.as_mut().unwrap().public_key =
        hex(attacker.verifying_key().to_encoded_point(false).as_bytes());
    store.snapshot().unwrap();
    fs::write(
        store.directory.join("state.json"),
        serde_json::to_vec(&forged).unwrap(),
    )
    .unwrap();
    assert_eq!(
        store
            .apply(
                signed(&attacker, &forged, 1, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "invalid_signature"
    );
    assert_eq!(store.snapshot().unwrap(), state);
    assert!(store
        .apply(
            signed(&key, &state, 1, Operation::Snapshot),
            ORIGIN,
            "challenge"
        )
        .is_ok());
}

#[test]
fn ledger_rollback_cannot_revert_logout_or_replay_sequence_after_restart() {
    let (directory, store, key, state, backend) = protected_fixture();
    let next = store
        .apply(
            signed(
                &key,
                &state,
                1,
                Operation::Invalidate {
                    reason: InvalidationReason::Logout,
                },
            ),
            ORIGIN,
            "challenge",
        )
        .unwrap();
    fs::write(
        store.directory.join("state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    drop(store);
    let restarted = Store::new(directory.path().join("protected"), backend);
    assert_eq!(restarted.snapshot().unwrap(), next);
    assert_eq!(
        restarted
            .apply(
                signed(&key, &state, 1, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "replayed_command"
    );
}

#[test]
fn missing_protected_state_does_not_import_ledger_or_reinitialize() {
    let (_directory, store, _key, state, backend) = protected_fixture();
    store.snapshot().unwrap();
    fs::write(
        store.directory.join("state.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    *backend.0.lock().unwrap() = None;
    assert_eq!(store.snapshot().unwrap_err(), "trusted_state_missing");
    assert!(backend.0.lock().unwrap().is_none());
}

#[test]
fn unsupported_or_corrupt_protected_schema_is_preserved() {
    let (_directory, store, _key, _state, backend) = protected_fixture();
    let mut record: serde_json::Value =
        serde_json::from_slice(backend.0.lock().unwrap().as_ref().unwrap()).unwrap();
    record["schema"] = 2.into();
    let bytes = serde_json::to_vec(&record).unwrap();
    *backend.0.lock().unwrap() = Some(bytes.clone());
    assert_eq!(store.snapshot().unwrap_err(), "unsupported_trusted_state");
    assert_eq!(*backend.0.lock().unwrap(), Some(bytes));
    *backend.0.lock().unwrap() = Some(b"corrupt".to_vec());
    assert_eq!(store.snapshot().unwrap_err(), "corrupt_trusted_state");
}

#[test]
fn protected_write_failure_never_returns_persisted() {
    struct Denied(State);
    impl StateStorage for Denied {
        fn load(&self) -> Result<State> {
            Ok(self.0.clone())
        }
        fn save(&self, _state: &State) -> Result<()> {
            Err("secure_storage_denied")
        }
    }
    let (directory, _legacy, key, state) = fixture();
    let store = Store::new(directory.path().join("protected"), Denied(state.clone()));
    assert_eq!(
        store
            .apply(
                signed(&key, &state, 1, Operation::Snapshot),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "secure_storage_denied"
    );
    assert_eq!(store.snapshot().unwrap(), state);
}

#[test]
fn revision_exhaustion_does_not_commit_partial_mutation() {
    let (_directory, store, key, mut state, backend) = protected_fixture();
    state.revision = u64::MAX;
    backend.save(&state).unwrap();
    assert_eq!(
        store
            .apply(
                signed(&key, &state, 1, Operation::Unpair),
                ORIGIN,
                "challenge"
            )
            .unwrap_err(),
        "revision_exhausted"
    );
    assert_eq!(store.snapshot().unwrap(), state);
}
