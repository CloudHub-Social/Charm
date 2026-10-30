use std::process::Command;

#[test]
fn inspection_stops_on_invalid_mode_and_incomplete_configuration() {
    for mode in ["invalid", "1"] {
        let output = Command::new(env!("CARGO_BIN_EXE_charm-web-server"))
            .env_clear()
            .env("CHARM_WEB_SERVER_INVENTORY_INSPECT_ONLY", mode)
            .output()
            .expect("start inspection process");

        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        assert_eq!(output.stderr, b"state inventory inspection unavailable\n");
    }
}
