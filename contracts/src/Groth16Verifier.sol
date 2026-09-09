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

    uint256 private constant DELTA_X_IM = 14396541108165626688162537035531160573377629993881382195177661661649243850438;
    uint256 private constant DELTA_X_RE = 15117469475600928859655891050745037472037857643076140077684669873083785855835;
    uint256 private constant DELTA_Y_IM = 20956502109796687887755677915458196140773239770086309355390968078114689092168;
    uint256 private constant DELTA_Y_RE = 14724110035623072662231149051404574881934339985901216423550378798530447619473;

    uint256 private constant IC0_X = 16841707485247708847096328610435040376408042900622115723338328241032895189312;
    uint256 private constant IC0_Y = 14010253175157813608747746863401718391807281039958756227594623097995987954584;
    uint256 private constant IC1_X = 14080211305987567518019727240531223543130354638819936035807987563201395943676;
    uint256 private constant IC1_Y = 18804377856586480768942190626567605682738638402534544266657585584186322722976;
    uint256 private constant IC2_X = 18221114622949088760266045145514382447668341235744457544463081279263256679286;
    uint256 private constant IC2_Y = 12597331908758091814265828388252286549171180195985118018950580777155526372675;
    uint256 private constant IC3_X = 21495946353904263953530925328078615563190741731807830530577185461004627263709;
    uint256 private constant IC3_Y = 6630966400057807009954036662329549096292401549301716006260812474286649496066;
    uint256 private constant IC4_X = 13084978677071067089300217700669257664518351607413464657106240580955480444984;
    uint256 private constant IC4_Y = 3453606043917155647064869009578821309126537001016407649742993388075195804243;
    uint256 private constant IC5_X = 15885527223348481548107691245186621344661468998976328610207918970291084390138;
    uint256 private constant IC5_Y = 5962269158860686593877414496918350897733321647478185597423181090844401478247;
    uint256 private constant IC6_X = 17364260135436160149884087641614404541147997527178986904981546595352129117405;
    uint256 private constant IC6_Y = 17281199503627168531444624523257813468628903523883465998843677070364856822721;
    uint256 private constant IC7_X = 7075629539547293943336689194871665712887096406859077724063095058705132105666;
    uint256 private constant IC7_Y = 8300361141367028132841310782537845827934045469401660880722852772247681452608;
    uint256 private constant IC8_X = 3078975280347570656359247136002752394138173711836616639322583592247119402237;
    uint256 private constant IC8_Y = 10571661554683915014193964295899775298828169210810487141618036654793263981484;

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
