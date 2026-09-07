// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

contract Groth16Verifier {
    uint256 private constant SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 private constant BASE_FIELD =
        21888242871839275222246405745257275088696311157297823662689037894645226208583;
    uint256 private constant PUBLIC_INPUTS = 8;

    address private constant EC_ADD = address(0x06);
    address private constant EC_MUL = address(0x07);
    address private constant PAIRING = address(0x08);

    uint256 private constant ALPHA_X = 16428432848801857252194528405604668803277877773566238944394625302971855135431;
    uint256 private constant ALPHA_Y = 16846502678714586896801519656441059708016666274385668027902869494772365009666;

    uint256 private constant BETA_X_IM = 3182164110458002340215786955198810119980427837186618912744689678939861918171;
    uint256 private constant BETA_X_RE = 16348171800823588416173124589066524623406261996681292662100840445103873053252;
    uint256 private constant BETA_Y_IM = 4920802715848186258981584729175884379674325733638798907835771393452862684714;
    uint256 private constant BETA_Y_RE = 19687132236965066906216944365591810874384658708175106803089633851114028275753;

    uint256 private constant GAMMA_X_IM = 11559732032986387107991004021392285783925812861821192530917403151452391805634;
    uint256 private constant GAMMA_X_RE = 10857046999023057135944570762232829481370756359578518086990519993285655852781;
    uint256 private constant GAMMA_Y_IM = 4082367875863433681332203403145435568316851327593401208105741076214120093531;
    uint256 private constant GAMMA_Y_RE = 8495653923123431417604973247489272438418190587263600148770280649306958101930;

    uint256 private constant DELTA_X_IM = 4386061935574785204117506073744982178069469223228850286997294772266612514834;
    uint256 private constant DELTA_X_RE = 8141895193386382829600398786110052259980942407012205585084201487801315312054;
    uint256 private constant DELTA_Y_IM = 7209490113208562067792642822285695758324179905969560791660714750693976646449;
    uint256 private constant DELTA_Y_RE = 3093958558210421619248448068964310154146584710046614723688077293642316355319;

    uint256 private constant IC0_X = 14356068746863727973308921549689713072190441835792285784409197830350841544963;
    uint256 private constant IC0_Y = 12124858840005168776419764958216921110879140161618518058073841843936402556802;
    uint256 private constant IC1_X = 18828389298521183624848751558861021544463786199386425424804048247470764346585;
    uint256 private constant IC1_Y = 6010214373863455003448413503485840010831105343971452936548332231428650358401;
    uint256 private constant IC2_X = 3471114265933139933173103019880380735215048328990586286582497061069515732584;
    uint256 private constant IC2_Y = 1890497648345219482007981400697329396734000117408651335681378506512623373562;
    uint256 private constant IC3_X = 9291011798622986062950028164388688999738920997474053444538359252064707709025;
    uint256 private constant IC3_Y = 20185796439938119320949585941230271842258824292043274982008372999957656550884;
    uint256 private constant IC4_X = 6772343820728264173408167265058519652439106054449630203811579412189859071399;
    uint256 private constant IC4_Y = 15584758481759868303991448623704597146027119604912722494492909368062604267783;
    uint256 private constant IC5_X = 7967177236828037244575030291911809886374853088625516131815138894890893105348;
    uint256 private constant IC5_Y = 3308530077251221105742804282373888699075521016348874336117097137050946371552;
    uint256 private constant IC6_X = 20672165749332812997801447999472146395634725830051030620697776428885481102995;
    uint256 private constant IC6_Y = 18407597761217576327960040439614656362934262710939682301052921901535150836669;
    uint256 private constant IC7_X = 13158215941120235815136700145516967364057516005374406435164138116391225241450;
    uint256 private constant IC7_Y = 14906467750623134272555715131618748309644524259535285430416255375196673479014;
    uint256 private constant IC8_X = 21703996313603579847740841960225944157641799680645690879584555653596610088129;
    uint256 private constant IC8_Y = 20712523095615807485281026453618460502233293187146020859716891596660333625060;

    function verifyProof(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256[8] calldata input
    ) public view returns (bool) {
        for (uint256 i = 0; i < PUBLIC_INPUTS; i++) {
            if (input[i] >= SCALAR_FIELD) return false;
        }
        (bool combined, uint256 lx, uint256 ly) = _publicInputCommitment(input);
        if (!combined) return false;
        return _pairingProductIsOne(a, b, c, lx, ly);
    }

    function _publicInputCommitment(uint256[8] calldata input) private view returns (bool, uint256, uint256) {
        uint256[2][8] memory ic = [
            [IC1_X, IC1_Y],
            [IC2_X, IC2_Y],
            [IC3_X, IC3_Y],
            [IC4_X, IC4_Y],
            [IC5_X, IC5_Y],
            [IC6_X, IC6_Y],
            [IC7_X, IC7_Y],
            [IC8_X, IC8_Y]
        ];
        uint256 x = IC0_X;
        uint256 y = IC0_Y;
        for (uint256 i = 0; i < PUBLIC_INPUTS; i++) {
            (bool scaled, uint256 px, uint256 py) = _scalarMultiply(ic[i][0], ic[i][1], input[i]);
            if (!scaled) return (false, 0, 0);
            (bool added, uint256 sx, uint256 sy) = _add(x, y, px, py);
            if (!added) return (false, 0, 0);
            x = sx;
            y = sy;
        }
        return (true, x, y);
    }

    function _scalarMultiply(uint256 x, uint256 y, uint256 scalar) private view returns (bool, uint256, uint256) {
        (bool ok, bytes memory out) = EC_MUL.staticcall(abi.encode(x, y, scalar));
        if (!ok || out.length != 64) return (false, 0, 0);
        (uint256 rx, uint256 ry) = abi.decode(out, (uint256, uint256));
        return (true, rx, ry);
    }

    function _add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) private view returns (bool, uint256, uint256) {
        (bool ok, bytes memory out) = EC_ADD.staticcall(abi.encode(x1, y1, x2, y2));
        if (!ok || out.length != 64) return (false, 0, 0);
        (uint256 rx, uint256 ry) = abi.decode(out, (uint256, uint256));
        return (true, rx, ry);
    }

    function _pairingProductIsOne(
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c,
        uint256 lx,
        uint256 ly
    ) private view returns (bool) {
        if (a[1] >= BASE_FIELD) return false;
        uint256 negatedAy = a[1] == 0 ? 0 : BASE_FIELD - a[1];
        uint256[24] memory pairs;
        pairs[0] = a[0];
        pairs[1] = negatedAy;
        pairs[2] = b[0][0];
        pairs[3] = b[0][1];
        pairs[4] = b[1][0];
        pairs[5] = b[1][1];
        pairs[6] = ALPHA_X;
        pairs[7] = ALPHA_Y;
        pairs[8] = BETA_X_IM;
        pairs[9] = BETA_X_RE;
        pairs[10] = BETA_Y_IM;
        pairs[11] = BETA_Y_RE;
        pairs[12] = lx;
        pairs[13] = ly;
        pairs[14] = GAMMA_X_IM;
        pairs[15] = GAMMA_X_RE;
        pairs[16] = GAMMA_Y_IM;
        pairs[17] = GAMMA_Y_RE;
        pairs[18] = c[0];
        pairs[19] = c[1];
        pairs[20] = DELTA_X_IM;
        pairs[21] = DELTA_X_RE;
        pairs[22] = DELTA_Y_IM;
        pairs[23] = DELTA_Y_RE;
        (bool ok, bytes memory out) = PAIRING.staticcall(abi.encode(pairs));
        if (!ok || out.length != 32) return false;
        return abi.decode(out, (uint256)) == 1;
    }
}
