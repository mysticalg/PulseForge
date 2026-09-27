//! Bind authorized amounts and slippage to Jupiter's actual signed instruction.
//!
//! V1/V2 layouts and all 179 Swap variants are pinned to the program-owned
//! on-chain Anchor IDL at C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa.
//! Retrieved at finalized slot 444724285 from https://api.mainnet-beta.solana.com.
//! See docs/JUPITER_ONCHAIN_IDL_2026-09-06.json and its .source.json companion.
//! SHA-256: ccc432865fca208e5650ac004d6cb7df48181a59ccafd4425271a0d4a278f3a9.
//! Account owner: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4.
//! Exact-out, token-ledger and future AMM variants remain unsupported. Never
//! infer a tail offset from unrecognized instruction data.

const ROUTE: [u8; 8] = [229, 23, 203, 151, 122, 227, 173, 42];
const SHARED_ACCOUNTS_ROUTE: [u8; 8] = [193, 32, 155, 51, 65, 214, 156, 129];
const ROUTE_V2: [u8; 8] = [187, 100, 250, 204, 49, 196, 175, 20];
const SHARED_ACCOUNTS_ROUTE_V2: [u8; 8] = [209, 152, 83, 147, 124, 254, 216, 233];
const MAX_INSTRUCTION_BYTES: usize = 1232;
const MAX_ROUTE_STEPS: usize = 32;
const MAX_REMAINING_SLICES: usize = 32;

/// Pure validation only: no networking, wallet access, signing or mutation.
pub fn validate_jupiter_instruction(
    data: &[u8],
    input_raw: u64,
    quoted_output_raw: u64,
    max_slippage_bps: u64,
    max_fee_bps: u64,
) -> Result<(), String> {
    if input_raw == 0 || quoted_output_raw == 0 || max_slippage_bps >= 10_000 || max_fee_bps > 10_000 {
        return Err("Invalid authorized Jupiter amounts or slippage limits".into());
    }
    if data.len() < 8 || data.len() > MAX_INSTRUCTION_BYTES {
        return Err("Jupiter instruction exceeds supported length bounds".into());
    }
    let mut cursor = Cursor { data, offset: 8 };
    let v2 = data[..8] == ROUTE_V2 || data[..8] == SHARED_ACCOUNTS_ROUTE_V2;
    if data[..8] == SHARED_ACCOUNTS_ROUTE || data[..8] == SHARED_ACCOUNTS_ROUTE_V2 {
        // Shared account authority index precedes the route vector.
        cursor.u8()?;
    } else if data[..8] != ROUTE && data[..8] != ROUTE_V2 {
        return Err(format!("Unsupported Jupiter instruction discriminator {:02x?}; only verified V1/V2 exact-input routes can be signed", &data[..8]));
    }

    // V2 moved amounts BEFORE the route vector, widened platform fees to u16
    // and introduced positive_slippage_bps. These are not V1 tail layouts.
    let (encoded_input, encoded_output, encoded_slippage, encoded_fee, positive_fee) = if v2 {
        let fields = (cursor.u64()?, cursor.u64()?, cursor.u16()? as u64,
            cursor.u16()? as u64, cursor.u16()? as u64);
        parse_route_plan(&mut cursor, true)?;
        fields
    } else {
        parse_route_plan(&mut cursor, false)?;
        (cursor.u64()?, cursor.u64()?, cursor.u16()? as u64, cursor.u8()? as u64, 0)
    };
    if cursor.offset != data.len() {
        return Err("Jupiter instruction has trailing or unrecognized fields".into());
    }
    if encoded_input != input_raw {
        return Err("Signed Jupiter instruction changes the authorized exact input".into());
    }
    if encoded_output != quoted_output_raw {
        return Err("Signed Jupiter instruction changes the authorized quoted output".into());
    }
    if encoded_slippage > max_slippage_bps || encoded_slippage >= 10_000 {
        return Err("Signed Jupiter instruction exceeds the authorized slippage".into());
    }
    // Conservatively count the positive-slippage field within the same fee
    // budget. A new fee mechanism cannot silently expand user authorization.
    if encoded_fee + positive_fee > max_fee_bps {
        return Err("Signed Jupiter instruction exceeds the authorized platform and positive-slippage fee budget".into());
    }
    let minimum_output = encoded_output as u128 * (10_000 - encoded_slippage) as u128 / 10_000;
    let authorized_minimum = quoted_output_raw as u128 * (10_000 - max_slippage_bps) as u128 / 10_000;
    if minimum_output == 0 || minimum_output < authorized_minimum {
        return Err("Signed Jupiter instruction does not enforce the authorized minimum output".into());
    }
    Ok(())
}

fn parse_route_plan(cursor: &mut Cursor<'_>, v2: bool) -> Result<(), String> {
    let steps = cursor.u32()? as usize;
    if steps == 0 || steps > MAX_ROUTE_STEPS {
        return Err("Jupiter route must contain 1–32 verified swap steps".into());
    }
    for _ in 0..steps {
        parse_swap(cursor)?;
        let weight = if v2 { cursor.u16()? } else { cursor.u8()? as u16 };
        if weight == 0 || weight > if v2 { 10_000 } else { 100 } {
            return Err("Invalid Jupiter route percentage or basis-point weight".into());
        }
        cursor.u8()?; // inputIndex
        cursor.u8()?; // outputIndex
    }
    Ok(())
}

fn parse_swap(cursor: &mut Cursor<'_>) -> Result<(), String> {
    let variant = cursor.u8()?;
    match variant {
        // No payload in the pinned Jupiter IDL, including Raydium, Meteora,
        // RaydiumCP, PumpdotfunWrappedBuy/Sell, Moonshot and Stabble.
        0..=7 | 9..=11 | 13..=14 | 19..=20 | 22 | 25..=26 | 30..=32
        | 34..=38 | 40 | 46 | 48..=57 | 59 | 62..=63 | 65..=70 | 72..=74
        | 76..=80 | 83..=84 | 88 | 90..=93 | 96..=102 | 105 | 108..=109
        | 112..=115 | 124 | 128 | 130..=131 | 133..=134 | 137..=140
        | 142..=144 | 147..=150 | 154 | 156 | 158 | 163 | 169 | 173 | 175..=176 => {}
        // These have one Borsh bool or the two-variant Side enum (Bid/Ask).
        8 | 12 | 15..=18 | 21 | 23..=24 | 27..=28 | 39 | 58 | 60..=61
        | 64 | 85 | 89 | 94..=95 | 104 | 106..=107 | 110 | 116..=117
        | 119 | 121 | 125 | 127 | 129 | 136 | 141 | 145 | 151..=153
        | 160 | 162 | 164..=166 | 168 | 174 | 177..=178 => {
            cursor.binary_tag()?;
        }
        29 => { cursor.take(16)?; } // Symmetry: fromTokenId, toTokenId (u64).
        33 | 41 => { cursor.take(4)?; } // StakeDex bridgeStakeSeed (u32).
        42 => { // Clone: poolIndex, quantityIsInput, quantityIsCollateral.
            cursor.u8()?;
            cursor.binary_tag()?;
            cursor.binary_tag()?;
        }
        43 | 135 => { cursor.take(10)?; } // SanctumS/V2: u8, u8, u32, u32.
        44..=45 => { cursor.take(5)?; } // Sanctum liquidity: u8, u32.
        47 | 103 => { // WhirlpoolSwapV2/DefiTuna: bool, Option<RemainingAccountsInfo>.
            cursor.binary_tag()?;
            if cursor.binary_tag()? == 1 { parse_remaining_accounts(cursor)?; }
        }
        71 => { cursor.take(2)?; } // Perena input/output indices.
        75 => parse_remaining_accounts(cursor)?,
        81..=82 | 159 => { cursor.take(8)?; }
        86 => { cursor.binary_tag()?; cursor.u8()?; }
        87 | 118 | 157 => { cursor.take(8)?; cursor.binary_tag()?; }
        111 => {
            let count = parse_candidates(cursor, false)?;
            if cursor.binary_tag()? == 1 && cursor.u8()? as usize >= count {
                return Err("Invalid Jupiter dynamic best-candidate index".into());
            }
        }
        120 => {
            cursor.binary_tag()?;
            let length = cursor.u32()? as usize;
            if length > MAX_INSTRUCTION_BYTES { return Err("Jupiter RFQ payload exceeds verification bounds".into()); }
            cursor.take(length)?;
        }
        122 => { cursor.take(16)?; }
        123 => { cursor.take(48)?; }
        126 => { cursor.binary_tag()?; cursor.take(16)?; }
        132 | 172 => { cursor.enum_tag(8)?; }
        146 => { parse_candidates(cursor, true)?; cursor.take(2)?; }
        155 | 167 => { cursor.binary_tag()?; cursor.binary_tag()?; }
        161 => { cursor.binary_tag()?; cursor.take(4)?; }
        170 => { cursor.u8()?; }
        171 => { cursor.enum_tag(3)?; }
        _ => return Err(format!("Unsupported Jupiter swap variant {variant}; its instruction layout has not been verified")),
    }
    Ok(())
}

fn parse_remaining_accounts(cursor: &mut Cursor<'_>) -> Result<(), String> {
    let slices = cursor.u32()? as usize;
    if slices > MAX_REMAINING_SLICES {
        return Err("Jupiter remaining-account vector exceeds verification bounds".into());
    }
    // The current on-chain IDL defines accounts_type as u8, not the old
    // two-variant AccountsType enum. These are structurally two-byte slices.
    cursor.take(slices * 2)?;
    Ok(())
}

fn parse_candidates(cursor: &mut Cursor<'_>, with_bps: bool) -> Result<usize, String> {
    let count = cursor.u32()? as usize;
    if count == 0 || count > MAX_ROUTE_STEPS {
        return Err("Jupiter dynamic-candidate vector exceeds verification bounds".into());
    }
    for _ in 0..count {
        match cursor.u8()? {
            0 | 2 => { cursor.take(8)?; cursor.binary_tag()?; }
            1 | 5 | 7..=9 | 12 | 14 => { cursor.binary_tag()?; }
            3..=4 | 6 | 11 | 13 => {}
            10 => {
                cursor.binary_tag()?;
                if cursor.binary_tag()? == 1 { parse_remaining_accounts(cursor)?; }
            }
            variant => return Err(format!("Unsupported Jupiter dynamic swap variant {variant}")),
        }
        if with_bps { cursor.u32()?; }
    }
    Ok(count)
}

struct Cursor<'a> { data: &'a [u8], offset: usize }
impl<'a> Cursor<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self.offset.checked_add(length).ok_or("Jupiter instruction length overflow")?;
        let value = self.data.get(self.offset..end).ok_or("Truncated Jupiter instruction body")?;
        self.offset = end;
        Ok(value)
    }
    fn u8(&mut self) -> Result<u8, String> { Ok(self.take(1)?[0]) }
    fn u16(&mut self) -> Result<u16, String> { Ok(u16::from_le_bytes(self.take(2)?.try_into().map_err(|_| "Invalid Jupiter u16")?)) }
    fn u32(&mut self) -> Result<u32, String> { Ok(u32::from_le_bytes(self.take(4)?.try_into().map_err(|_| "Invalid Jupiter u32")?)) }
    fn u64(&mut self) -> Result<u64, String> { Ok(u64::from_le_bytes(self.take(8)?.try_into().map_err(|_| "Invalid Jupiter u64")?)) }
    fn binary_tag(&mut self) -> Result<u8, String> {
        self.enum_tag(2)
    }
    fn enum_tag(&mut self, count: u8) -> Result<u8, String> {
        let value = self.u8()?;
        if value >= count { return Err("Invalid Jupiter Borsh bool, option or enum tag".into()); }
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INPUT: u64 = 50_000_000;
    const OUTPUT: u64 = 123_456_789;

    fn route(shared: bool, swaps: &[&[u8]], input: u64, output: u64, slip: u16, fee: u8) -> Vec<u8> {
        let mut data = if shared { SHARED_ACCOUNTS_ROUTE.to_vec() } else { ROUTE.to_vec() };
        if shared { data.push(3); }
        data.extend_from_slice(&(swaps.len() as u32).to_le_bytes());
        for swap in swaps {
            data.extend_from_slice(swap);
            data.extend_from_slice(&[100, 0, 1]);
        }
        data.extend_from_slice(&input.to_le_bytes());
        data.extend_from_slice(&output.to_le_bytes());
        data.extend_from_slice(&slip.to_le_bytes());
        data.push(fee);
        data
    }

    fn check(data: &[u8]) -> Result<(), String> { validate_jupiter_instruction(data, INPUT, OUTPUT, 100, 50) }

    fn route_v2(shared: bool, swaps: &[&[u8]], input: u64, output: u64, slip: u16, fee: u16, positive_fee: u16) -> Vec<u8> {
        let mut data = if shared { SHARED_ACCOUNTS_ROUTE_V2.to_vec() } else { ROUTE_V2.to_vec() };
        if shared { data.push(3); }
        data.extend_from_slice(&input.to_le_bytes());
        data.extend_from_slice(&output.to_le_bytes());
        data.extend_from_slice(&slip.to_le_bytes());
        data.extend_from_slice(&fee.to_le_bytes());
        data.extend_from_slice(&positive_fee.to_le_bytes());
        data.extend_from_slice(&(swaps.len() as u32).to_le_bytes());
        for swap in swaps {
            data.extend_from_slice(swap);
            data.extend_from_slice(&10_000u16.to_le_bytes());
            data.extend_from_slice(&[0, 1]);
        }
        data
    }

    #[test]
    fn verifies_both_v1_exact_input_route_layouts() {
        for shared in [false, true] {
            assert!(check(&route(shared, &[&[7]], INPUT, OUTPUT, 100, 50)).is_ok());
            assert!(check(&route(shared, &[&[49]], INPUT, OUTPUT, 0, 0)).is_ok());
            assert!(check(&route(shared, &[&[50], &[46]], INPUT, OUTPUT, 50, 5)).is_ok());
        }
    }

    #[test]
    fn rejects_changed_input_output_slippage_and_platform_fee() {
        for data in [
            route(false, &[&[7]], INPUT + 1, OUTPUT, 100, 50),
            route(false, &[&[7]], INPUT, OUTPUT - 1, 100, 50),
            route(false, &[&[7]], INPUT, OUTPUT + 1, 100, 50),
            route(false, &[&[7]], INPUT, 0, 0, 0),
            route(false, &[&[7]], INPUT, OUTPUT, 101, 50),
            route(false, &[&[7]], INPUT, OUTPUT, 10_000, 0),
            route(false, &[&[7]], INPUT, OUTPUT, 100, 51),
        ] { assert!(check(&data).is_err()); }
    }

    #[test]
    fn decodes_every_verified_swap_variant_and_its_payload() {
        for variant in 0..=61 {
            let mut swap = vec![variant];
            match variant {
                8 | 12 | 15..=18 | 21 | 23..=24 | 27..=28 | 39 | 58 | 60..=61 => swap.push(1),
                29 => swap.extend_from_slice(&[0; 16]),
                33 | 41 => swap.extend_from_slice(&[0; 4]),
                42 => swap.extend_from_slice(&[9, 1, 0]),
                43 => swap.extend_from_slice(&[0; 10]),
                44..=45 => swap.extend_from_slice(&[0; 5]),
                47 => swap.extend_from_slice(&[1, 0]),
                _ => {}
            }
            assert!(check(&route(false, &[&swap], INPUT, OUTPUT, 100, 50)).is_ok(), "variant {variant}");
        }
        let whirlpool = [47, 1, 1, 2, 0, 0, 0, 0, 3, 1, 4];
        assert!(check(&route(true, &[&whirlpool], INPUT, OUTPUT, 100, 50)).is_ok());
    }

    #[test]
    fn rejects_malformed_borsh_variants_options_and_vectors() {
        for swap in [&[8, 2][..], &[12, 2], &[42, 0, 1, 2], &[47, 1, 2],
            &[47, 1, 1, 33, 0, 0, 0], &[47, 1, 1, 255, 255, 255, 255], &[179], &[255]] {
            assert!(check(&route(false, &[swap], INPUT, OUTPUT, 100, 50)).is_err());
        }
        let empty = route(false, &[], INPUT, OUTPUT, 100, 50);
        assert!(check(&empty).is_err());
        let mut excessive = route(false, &[&[7]], INPUT, OUTPUT, 100, 50);
        excessive[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(check(&excessive).is_err());
        for percent in [0, 101, 255] {
            let mut invalid = route(false, &[&[7]], INPUT, OUTPUT, 100, 50);
            invalid[13] = percent;
            assert!(check(&invalid).is_err());
        }
    }

    #[test]
    fn cannot_hide_an_unverified_body_before_a_valid_tail() {
        let mut data = route(false, &[&[7]], INPUT, OUTPUT, 100, 50);
        data.insert(12, 255);
        assert!(check(&data).is_err());
        let mut trailing = route(false, &[&[7]], INPUT, OUTPUT, 100, 50);
        trailing.extend_from_slice(&[0; 19]);
        assert!(check(&trailing).is_err());
        let missing_payload = route(false, &[&[29]], INPUT, OUTPUT, 100, 50);
        assert!(check(&missing_payload).is_err());
    }

    #[test]
    fn rejects_unknown_ledger_and_exact_output_discriminators() {
        for discriminator in [
            [0; 8],
            [150, 86, 71, 116, 167, 93, 14, 104], // route_with_token_ledger
            [176, 209, 105, 168, 154, 125, 69, 62], // shared_accounts_exact_out_route
        ] {
            let mut data = route(false, &[&[7]], INPUT, OUTPUT, 100, 50);
            data[..8].copy_from_slice(&discriminator);
            assert!(check(&data).unwrap_err().contains("Unsupported Jupiter instruction discriminator"));
        }
    }

    #[test]
    fn all_truncation_points_and_oversized_inputs_fail_without_panicking() {
        let valid = route(true, &[&[47, 1, 1, 1, 0, 0, 0, 0, 4], &[29, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]], INPUT, OUTPUT, 100, 50);
        assert!(check(&valid).is_ok());
        for end in 0..valid.len() { assert!(check(&valid[..end]).is_err(), "truncation {end}"); }
        assert!(check(&vec![0; MAX_INSTRUCTION_BYTES + 1]).is_err());
    }

    #[test]
    fn minimum_output_math_is_bounded_and_never_rounds_to_zero() {
        let maximum = route(false, &[&[7]], u64::MAX, u64::MAX, 100, 50);
        assert!(validate_jupiter_instruction(&maximum, u64::MAX, u64::MAX, 100, 50).is_ok());
        let dust = route(false, &[&[7]], 1, 1, 100, 0);
        assert!(validate_jupiter_instruction(&dust, 1, 1, 100, 50).is_err());
        assert!(validate_jupiter_instruction(&maximum, 0, u64::MAX, 100, 50).is_err());
        assert!(validate_jupiter_instruction(&maximum, u64::MAX, u64::MAX, 10_000, 50).is_err());
    }

    #[test]
    fn supports_verified_v2_pump_launch_and_pumpswap_layouts() {
        for shared in [false, true] {
            for swap in [&[49][..], &[50], &[72], &[73], &[90], &[91], &[92], &[93], &[97], &[98],
                &[99], &[100], &[112], &[113], &[147], &[148], &[149], &[150], &[152, 1], &[153, 0]] {
                assert!(check(&route_v2(shared, &[swap], INPUT, OUTPUT, 100, 30, 20)).is_ok());
            }
        }
    }

    #[test]
    fn binds_v2_prefix_amounts_slippage_and_both_u16_fee_fields() {
        for data in [
            route_v2(false, &[&[72]], INPUT + 1, OUTPUT, 100, 0, 0),
            route_v2(false, &[&[72]], INPUT, OUTPUT - 1, 100, 0, 0),
            route_v2(false, &[&[72]], INPUT, OUTPUT, 101, 0, 0),
            route_v2(false, &[&[72]], INPUT, OUTPUT, 100, 300, 0),
            route_v2(false, &[&[72]], INPUT, OUTPUT, 100, 0, 10_000),
            route_v2(false, &[&[72]], INPUT, OUTPUT, 100, 30, 21),
        ] { assert!(check(&data).is_err()); }
        let mut v1_disguised = route(false, &[&[72]], INPUT, OUTPUT, 100, 50);
        v1_disguised[..8].copy_from_slice(&ROUTE_V2);
        assert!(check(&v1_disguised).is_err());
        let mut bad_bps = route_v2(false, &[&[72]], INPUT, OUTPUT, 100, 50, 0);
        bad_bps[35..37].copy_from_slice(&10_001u16.to_le_bytes());
        assert!(check(&bad_bps).is_err());
        bad_bps[35..37].copy_from_slice(&0u16.to_le_bytes());
        assert!(check(&bad_bps).is_err());
    }

    #[test]
    fn all_v2_truncations_and_malformed_dynamic_payloads_fail() {
        let valid = route_v2(true, &[&[152, 1], &[47, 0, 1, 1, 0, 0, 0, 8, 2]], INPUT, OUTPUT, 100, 50, 0);
        assert!(check(&valid).is_ok());
        for end in 0..valid.len() { assert!(check(&valid[..end]).is_err(), "V2 truncation {end}"); }
        for swap in [&[111, 0, 0, 0, 0][..], &[111, 1, 0, 0, 0, 255],
            &[111, 1, 0, 0, 0, 3, 1, 1], &[146, 255, 255, 255, 255],
            &[120, 0, 255, 255, 255, 255], &[132, 8], &[171, 3], &[155, 2, 0]] {
            assert!(check(&route_v2(false, &[swap], INPUT, OUTPUT, 100, 50, 0)).is_err());
        }
    }

    #[test]
    fn matches_every_swap_variant_to_the_pinned_program_owned_idl() {
        use serde_json::Value;
        let idl: Value = serde_json::from_str(include_str!("../../docs/JUPITER_ONCHAIN_IDL_2026-09-06.json")).unwrap();
        let types = idl["types"].as_array().unwrap();

        // Independently serialize structural fixtures from the authoritative
        // schema, rather than mirroring the hand-written decoder's offsets.
        fn encode_type(ty: &Value, types: &[Value], bytes: &mut Vec<u8>) {
            match ty.as_str() {
                Some("bool") => bytes.push(1),
                Some("u8") => bytes.push(0),
                Some("u16") => bytes.extend_from_slice(&[0; 2]),
                Some("u32") => bytes.extend_from_slice(&[0; 4]),
                Some("u64") => bytes.extend_from_slice(&[0; 8]),
                Some("u128") => bytes.extend_from_slice(&[0; 16]),
                Some("bytes") => bytes.extend_from_slice(&[1, 0, 0, 0, 42]),
                Some(other) => panic!("Unimplemented fixture primitive {other}"),
                None => {
                    if let Some(defined) = ty.get("defined") {
                        let name = defined.as_str().or_else(|| defined["name"].as_str()).unwrap();
                        let definition = &types.iter().find(|entry| entry["name"] == name).unwrap()["type"];
                        if definition["kind"] == "enum" {
                            bytes.push(0);
                            encode_fields(&definition["variants"][0], types, bytes);
                        } else { encode_fields(definition, types, bytes); }
                    } else if let Some(inner) = ty.get("option") {
                        bytes.push(1);
                        encode_type(inner, types, bytes);
                    } else if let Some(inner) = ty.get("vec") {
                        bytes.extend_from_slice(&1u32.to_le_bytes());
                        encode_type(inner, types, bytes);
                    } else if let Some(array) = ty.get("array").and_then(Value::as_array) {
                        for _ in 0..array[1].as_u64().unwrap() { encode_type(&array[0], types, bytes); }
                    } else { panic!("Unimplemented fixture type {ty}"); }
                }
            }
        }
        fn encode_fields(parent: &Value, types: &[Value], bytes: &mut Vec<u8>) {
            if let Some(fields) = parent.get("fields").and_then(Value::as_array) {
                for field in fields { encode_type(&field["type"], types, bytes); }
            }
        }

        let variants = types.iter().find(|entry| entry["name"] == "Swap").unwrap()["type"]["variants"].as_array().unwrap();
        assert_eq!(variants.len(), 179);
        for (index, variant) in variants.iter().enumerate() {
            let mut swap = vec![index as u8];
            encode_fields(variant, types, &mut swap);
            for v2 in [false, true] {
                let data = if v2 { route_v2(true, &[&swap], INPUT, OUTPUT, 100, 50, 0) }
                    else { route(true, &[&swap], INPUT, OUTPUT, 100, 50) };
                assert!(check(&data).is_ok(), "IDL variant {index} {} / V2={v2}", variant["name"]);
            }
        }
        for (name, expected) in [("route", ROUTE), ("shared_accounts_route", SHARED_ACCOUNTS_ROUTE),
            ("route_v2", ROUTE_V2), ("shared_accounts_route_v2", SHARED_ACCOUNTS_ROUTE_V2)] {
            let instruction = idl["instructions"].as_array().unwrap().iter().find(|entry| entry["name"] == name).unwrap();
            let actual: Vec<u8> = instruction["discriminator"].as_array().unwrap().iter().map(|value| value.as_u64().unwrap() as u8).collect();
            assert_eq!(actual, expected);
        }
    }
}
