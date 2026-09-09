export const keeperEvaluatorAbi = [
  {
    "type": "constructor",
    "inputs": [
      {
        "name": "squareJob_",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "initialOwner",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "challengeWindow",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "disputeWindow",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "finalizeGrace_",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "acceptOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "applyRejection",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "resolutionHash",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "arbitration",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "challengeEndsAt",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "configureWindows",
    "inputs": [
      {
        "name": "challengeWindow",
        "type": "uint48",
        "internalType": "uint48"
      },
      {
        "name": "disputeWindow",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "currentWindow",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IKeeperEvaluator.Window",
        "components": [
          {
            "name": "effectiveFrom",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "challengeWindow",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "disputeWindow",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "finalizeGrace",
            "type": "uint48",
            "internalType": "uint48"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "dispute",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "evidence",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "disputeOf",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IKeeperEvaluator.DisputeRef",
        "components": [
          {
            "name": "disputer",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "disputedAt",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "resolved",
            "type": "bool",
            "internalType": "bool"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "finalize",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "complianceProof",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "finalizeDecided",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "complianceProof",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "finalizeGrace",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "finalizeReason",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "deliverable",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "isDisputed",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "pendingOwner",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "renounceOwnership",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setArbitration",
    "inputs": [
      {
        "name": "arbitration_",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "setFinalizeGrace",
    "inputs": [
      {
        "name": "finalizeGrace_",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "settlementHorizon",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "squareJob",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "supportsInterface",
    "inputs": [
      {
        "name": "interfaceId",
        "type": "bytes4",
        "internalType": "bytes4"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "transferOwnership",
    "inputs": [
      {
        "name": "newOwner",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "windowFor",
    "inputs": [
      {
        "name": "submittedAt",
        "type": "uint48",
        "internalType": "uint48"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "internalType": "struct IKeeperEvaluator.Window",
        "components": [
          {
            "name": "effectiveFrom",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "challengeWindow",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "disputeWindow",
            "type": "uint48",
            "internalType": "uint48"
          },
          {
            "name": "finalizeGrace",
            "type": "uint48",
            "internalType": "uint48"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "ArbitrationSet",
    "inputs": [
      {
        "name": "arbitration",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DecisionApplied",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "outcome",
        "type": "uint8",
        "indexed": false,
        "internalType": "uint8"
      },
      {
        "name": "providerBps",
        "type": "uint16",
        "indexed": false,
        "internalType": "uint16"
      },
      {
        "name": "keeper",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "keeperFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "DisputeRaised",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "disputer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "disputedAt",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "challengeEnd",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "FinalizeGraceConfigured",
    "inputs": [
      {
        "name": "finalizeGrace",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "Finalized",
    "inputs": [
      {
        "name": "jobId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "keeper",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "keeperFee",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferStarted",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OwnershipTransferred",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "WindowsConfigured",
    "inputs": [
      {
        "name": "effectiveFrom",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "challengeWindow",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      },
      {
        "name": "disputeWindow",
        "type": "uint48",
        "indexed": false,
        "internalType": "uint48"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "AlreadyResolved",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ArbitrationAlreadySet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ArbitrationNotSet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "Disputed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotDecided",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotDisputed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotOurJob",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotSubmitted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyArbitration",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OnlyClient",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SplitNeedsAPayoutResolver",
    "inputs": []
  },
  {
    "type": "error",
    "name": "WindowClosed",
    "inputs": [
      {
        "name": "challengeEnd",
        "type": "uint48",
        "internalType": "uint48"
      }
    ]
  },
  {
    "type": "error",
    "name": "WindowOpen",
    "inputs": [
      {
        "name": "challengeEnd",
        "type": "uint48",
        "internalType": "uint48"
      }
    ]
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroWindow",
    "inputs": []
  }
] as const;
