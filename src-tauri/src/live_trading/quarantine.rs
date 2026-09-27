use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedPosition {
    pub position: LivePosition,
    pub quarantined_at_ms: i64,
    pub risk_loss_usd: f64,
}

pub(super) fn load(
    connection: &Connection,
    owner: &str,
) -> Result<Vec<QuarantinedPosition>, String> {
    let mut statement = connection
        .prepare("SELECT payload FROM live_quarantine WHERE owner=?1 ORDER BY id")
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![owner], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    rows.into_iter()
        .map(|row| serde_json::from_str(&row).map_err(db_error))
        .collect()
}

pub(super) fn daily_loss(rows: &[QuarantinedPosition], start: i64) -> f64 {
    rows.iter()
        .filter(|row| row.quarantined_at_ms >= start)
        .map(|row| row.risk_loss_usd)
        .sum()
}

pub(super) fn validate_entry(
    rows: &[QuarantinedPosition],
    mint: &str,
    realized: f64,
    limit: f64,
    start: i64,
) -> Result<(), String> {
    if rows.iter().any(|row| row.position.mint == mint) {
        return Err("Automatic re-entry into a quarantined mint is blocked".into());
    }
    let loss = daily_loss(rows, start);
    if !loss.is_finite() || loss < 0.0 || !realized.is_finite() || realized - loss <= -limit {
        return Err("Live daily loss limit reached including quarantine risk losses; managed exits remain available".into());
    }
    Ok(())
}

pub(super) fn apply(
    connection: &mut Connection,
    owner: &str,
    id: &str,
    at: i64,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(db_error)?;
    // Repeating an acknowledged operation never charges a second loss.
    if load(&transaction, owner)?
        .iter()
        .any(|row| row.position.id == id)
    {
        return Ok(());
    }
    if load_orders(&transaction, owner)?
        .iter()
        .any(|order| pending(&order.order.status))
    {
        return Err("Pending live orders must reconcile before quarantine".into());
    }
    let position = load_position(&transaction, owner, id)?
        .ok_or("Managed position does not belong to this wallet")?;
    if at <= 0 || at.saturating_sub(position.last_mark_at_ms.max(position.opened_at_ms)) <= 75_000 {
        return Err(
            "Only a position without a fresh mark for over 75 seconds can be quarantined".into(),
        );
    }
    if !position.cost_basis_usd.is_finite()
        || position.cost_basis_usd <= 0.0
        || parse_raw(&position.quantity_raw)? == 0
    {
        return Err("Position accounting needs reconciliation before quarantine".into());
    }
    let row = QuarantinedPosition {
        risk_loss_usd: position.cost_basis_usd,
        position,
        quarantined_at_ms: at,
    };
    transaction
        .execute(
            "INSERT INTO live_quarantine(owner,id,payload) VALUES(?1,?2,?3)",
            params![owner, id, serde_json::to_string(&row).map_err(db_error)?],
        )
        .map_err(db_error)?;
    let removed = transaction
        .execute(
            "DELETE FROM live_positions WHERE owner=?1 AND id=?2",
            params![owner, id],
        )
        .map_err(db_error)?;
    if removed != 1 {
        return Err("Position changed while quarantining".into());
    }
    transaction.commit().map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize_db(&connection).unwrap();
        let position = LivePosition {
            id: "position".into(),
            mint: SOL_MINT.into(),
            symbol: "TEST".into(),
            quantity_raw: "100".into(),
            decimals: 6,
            entry_price_usd: 1.0,
            cost_basis_usd: 5.6,
            opened_at_ms: 1,
            last_mark_at_ms: 10,
            high_water_price_usd: 1.0,
            last_price_usd: 1.0,
            entry_liquidity_usd: 2000.0,
        };
        connection
            .execute(
                "INSERT INTO live_positions VALUES(?1,?2,?3)",
                params![
                    "owner",
                    position.id,
                    serde_json::to_string(&position).unwrap()
                ],
            )
            .unwrap();
        connection
    }
    #[test]
    fn quarantine_preserves_quantity_cost_and_history_without_a_sale_and_is_idempotent() {
        let mut connection = setup();
        let original =
            serde_json::to_string(&load_positions(&connection, "owner").unwrap()[0]).unwrap();
        apply(&mut connection, "owner", "position", 100_000).unwrap();
        apply(&mut connection, "owner", "position", 200_000).unwrap();
        let rows = load(&connection, "owner").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(serde_json::to_string(&rows[0].position).unwrap(), original);
        assert_eq!(rows[0].quarantined_at_ms, 100_000);
        assert_eq!(daily_loss(&rows, 0), 5.6);
        assert!(load_positions(&connection, "owner").unwrap().is_empty());
        assert!(load_orders(&connection, "owner").unwrap().is_empty());
        assert_eq!(daily_loss(&rows, 100_001), 0.0);
        assert!(validate_entry(&rows, "different-mint", 0.0, 10.0, 0).is_ok());
        assert!(validate_entry(&rows, "different-mint", 0.0, 5.0, 0).is_err());
        assert!(validate_entry(&rows, "different-mint", -5.0, 10.0, 0).is_err());
        assert!(validate_entry(&rows, SOL_MINT, 0.0, 10.0, 100_001).is_err());
        assert!(load(&connection, "another-wallet").unwrap().is_empty());
    }
    #[test]
    fn rejects_fresh_future_or_wrong_wallet_positions_without_mutation() {
        let mut connection = setup();
        for (owner, at) in [("owner", 75_010), ("owner", 1), ("another-wallet", 100_000)] {
            assert!(apply(&mut connection, owner, "position", at).is_err());
        }
        assert_eq!(load_positions(&connection, "owner").unwrap().len(), 1);
        assert!(load(&connection, "owner").unwrap().is_empty());
    }
}
