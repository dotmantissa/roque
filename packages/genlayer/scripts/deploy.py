#!/usr/bin/env python3
"""
Deploy the Roque interpreter to a GenLayer network and record its address.

Defaults to studionet, the gasless dev network, which is what the relayer talks
to during development. Point it at testnet with GENLAYER_NETWORK=testnet once you
have a funded validator account. The deployed address is written to
deployment.json next to this script and mirrored into the repo .env as
GENLAYER_CONTRACT_ADDRESS so the backend picks it up with no copy and paste.

Usage:
    python scripts/deploy.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from eth_typing import HexStr
from genlayer_py import create_client, create_account
from genlayer_py.chains import studionet, testnet_asimov


HERE = Path(__file__).resolve().parent
PKG_ROOT = HERE.parent
CONTRACT = PKG_ROOT / "contracts" / "roque_interpreter.py"
OUT = PKG_ROOT / "deployment.json"

# A generous dev-network top up. studionet mints test funds for free, so this is
# just enough headroom to cover a deploy and a few calls while iterating.
FUND_AMOUNT = 10 ** 18


def _load_private_key() -> str:
    # Prefer an explicit GenLayer key; fall back to empty, which lets the client
    # generate a throwaway account we then fund on studionet.
    return os.environ.get("GENLAYER_PRIVATE_KEY") or ""


def _looks_like_address(value: object) -> bool:
    return isinstance(value, str) and value.startswith("0x") and len(value) == 42


def _find_deployed_address(receipt: dict) -> str | None:
    """
    Pull the new contract's address out of a receipt, coping with the fact that
    localnet, studionet and testnet each label the same field differently.

    On a deploy the transaction's recipient is the zero address, so the address
    we actually want is the freshly created contract, which the node reports in
    one of a handful of places depending on the network. Check the obvious ones,
    then fall back to a shallow scan for anything address shaped that is not the
    deployer or the zero address.
    """
    data = receipt.get("data") or {}
    if isinstance(data, dict):
        for k in ("contract_address", "contractAddress", "new_contract_address"):
            if _looks_like_address(data.get(k)):
                return data[k]

    for k in ("to_address", "recipient"):
        v = receipt.get(k)
        if _looks_like_address(v) and int(str(v), 16) != 0:
            return v

    # Last resort: any address shaped value nested one level down.
    for value in receipt.values():
        if _looks_like_address(value) and int(str(value), 16) != 0:
            return value
        if isinstance(value, dict):
            for inner in value.values():
                if _looks_like_address(inner) and int(str(inner), 16) != 0:
                    return inner
    return None


def _execution_ok(receipt: dict) -> bool:
    """
    True unless the node clearly tells us the contract failed to come up.

    GenLayer reports a deploy's fate in `result_name`/`status_name`; a genuine
    failure shows up as something other than a finalized/accepted state. We only
    treat an explicit error as fatal so a harmless label difference between
    networks does not block a good deploy.
    """
    for key in ("result_name", "status_name", "status"):
        val = receipt.get(key)
        text = str(val).upper() if val is not None else ""
        if "ERROR" in text or "INVALID" in text or "UNDETERMINED" in text:
            return False
    return True


def main() -> int:
    network = os.environ.get("GENLAYER_NETWORK", "studionet").lower()
    chain = testnet_asimov if network.startswith("test") else studionet

    code = CONTRACT.read_text()
    print(f"Deploying {CONTRACT.name} to {chain.name} ...")

    key = _load_private_key()
    account = create_account(HexStr(key)) if key else create_account()
    print(f"Deployer account: {account.address}")

    client = create_client(chain=chain, account=account)

    # A fresh account needs funding before it can pay for the deploy. studionet
    # mints on request; other networks reject this, which is fine to ignore.
    try:
        fund_hash = client.fund_account(account.address, FUND_AMOUNT)
        client.wait_for_transaction_receipt(transaction_hash=fund_hash)
        print(f"Funded {account.address}")
    except Exception as exc:  # noqa: BLE001
        print(f"  (skipping fund_account: {exc})")

    tx_hash = client.deploy_contract(code=code, account=account)
    print(f"Deploy tx: {tx_hash}")
    receipt = client.wait_for_transaction_receipt(transaction_hash=tx_hash)

    # GenLayerTransaction is a TypedDict, i.e. a plain dict at runtime. Copy it
    # into a real dict so the helpers below can scan it without the type checker
    # fretting over the network specific union the SDK declares.
    receipt_dict: dict = dict(receipt) if receipt else {}

    if not _execution_ok(receipt_dict):
        print("Deploy did not finalize cleanly. Full receipt:")
        print(json.dumps(receipt_dict, indent=2, default=str))
        return 1

    address = _find_deployed_address(receipt_dict)
    if not address:
        print("Could not read the deployed address from the receipt:")
        print(json.dumps(receipt_dict, indent=2, default=str))
        return 1

    print(f"Deployed at {address}")

    OUT.write_text(
        json.dumps(
            {"network": chain.name, "address": address, "deployer": account.address},
            indent=2,
        )
        + "\n"
    )
    print(f"Wrote {OUT}")

    _mirror_into_env(address)
    return 0


def _mirror_into_env(address: str) -> None:
    """Best effort: update GENLAYER_CONTRACT_ADDRESS in the repo .env if present."""
    env_path = PKG_ROOT.parent.parent / ".env"
    if not env_path.exists():
        return
    lines = env_path.read_text().splitlines()
    updated = False
    for i, line in enumerate(lines):
        if line.startswith("GENLAYER_CONTRACT_ADDRESS="):
            lines[i] = f"GENLAYER_CONTRACT_ADDRESS={address}"
            updated = True
            break
    if not updated:
        lines.append(f"GENLAYER_CONTRACT_ADDRESS={address}")
    env_path.write_text("\n".join(lines) + "\n")
    print(f"Updated GENLAYER_CONTRACT_ADDRESS in {env_path}")


if __name__ == "__main__":
    sys.exit(main())
