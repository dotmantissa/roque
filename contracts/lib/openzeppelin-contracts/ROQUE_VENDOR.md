# Roque's OpenZeppelin source dependency

Roque consumes the existing vendored Solidity sources through Foundry's
`@openzeppelin/` remapping in `contracts/foundry.toml`. The Solidity files and
upstream MIT license are retained unchanged.

The upstream npm development manifest and stale npm lockfile were removed.
They installed Hardhat, documentation, release and JavaScript test tooling that
Roque's build and CI do not use. That separate toolchain contained 114 reported
vulnerabilities and its lockfile described a different upstream version from
the manifest. Removing the unused installation entrypoints reduces the
dependency surface without suppressing advisories or changing contract code.

Use the repository's documented Foundry build and test commands. To work on
OpenZeppelin's own JavaScript tooling, use a separate current upstream checkout
and its reviewed dependencies rather than restoring the stale lockfile here.
