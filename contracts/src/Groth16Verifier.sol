// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {SCALAR_FIELD} from "./interfaces/IGroth16Verifier.sol";

contract Groth16Verifier {
    // SCALAR_FIELD is imported rather than declared: PolicyRegistry needs the
    // same bound, and one value in one place is what keeps the two from drifting
    // (#231). BASE_FIELD stays here — only the pairing arithmetic uses it.
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

    uint256 private constant DELTA_X_IM = 486079315598310271262448250950856958628101905011001294965959005573878485726;
    uint256 private constant DELTA_X_RE = 17970260605039359289141301817121949188229955903294423401157093700089005448602;
    uint256 private constant DELTA_Y_IM = 12103288634455117196545689629002104087934065467279796571641161585840679315292;
    uint256 private constant DELTA_Y_RE = 18830527714076927532266623198842506540379091175982383298157441669651745790940;

    uint256 private constant IC0_X = 2994311263706440663790314763891185524960230742521408702202900306330247350583;
    uint256 private constant IC0_Y = 13846209441862833123956845692643930429681962122177385828087117096049778580409;
    uint256 private constant IC1_X = 9748648046896154383791455474639235685381687025323760290791890131922705206395;
    uint256 private constant IC1_Y = 3261585806174469597219484053961304481796144227579247604885773685537920478904;
    uint256 private constant IC2_X = 15573633602778785583414190370076395290004190103018642449887599656114980735949;
    uint256 private constant IC2_Y = 12456292583796123557982095486675499432382819156744404912680195310561827025664;
    uint256 private constant IC3_X = 891700355095500028072376622904705703731982335348572258674150388542312600766;
    uint256 private constant IC3_Y = 2055980301217280963524673847646167467740211531776543507066723960494737737543;
    uint256 private constant IC4_X = 2671465698365206215814930131428152989802779060033183445063212794235369821357;
    uint256 private constant IC4_Y = 2146645713007581594436860901239250354715204911521565196318265122792659718123;
    uint256 private constant IC5_X = 16418660236939830950069053122884123361797100688094809476412138615270101134237;
    uint256 private constant IC5_Y = 16896158012314847109076440103139971420552529230928885039694553589319601445911;
    uint256 private constant IC6_X = 17295861682901658962486250378267375793464350280105595142170055972200570794926;
    uint256 private constant IC6_Y = 17566802413896915409112740042735511657706680925214320913770190681652912672927;
    uint256 private constant IC7_X = 10709946933554617202009208127781414650052374376479950120620747155264092382002;
    uint256 private constant IC7_Y = 8462644551310298729418597462136370762673303760016679030468034337952272051009;
    uint256 private constant IC8_X = 1185313649030941706678877158193086034074605493514394385538935472236728233484;
    uint256 private constant IC8_Y = 12016711972806424715174328876086260356764310010157270138228702037398622995550;

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
