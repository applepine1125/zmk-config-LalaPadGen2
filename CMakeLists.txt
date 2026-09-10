set(_lalapad_sources)

if(CONFIG_ZMK_INPUT_PROCESSOR_SCROLL_ACCEL)
  list(APPEND _lalapad_sources src/input_processor_scroll_accel.c)
endif()

if(CONFIG_LALAPAD_TP_TUNER)
  list(APPEND _lalapad_sources src/behavior_tp_param.c src/lalapad_diag.c)
  if(CONFIG_ZMK_SPLIT_ROLE_CENTRAL)
    list(APPEND _lalapad_sources src/tp_tuner_central.c)
  else()
    list(APPEND _lalapad_sources src/tp_tuner_peripheral.c)
  endif()
endif()

if(_lalapad_sources)
  zephyr_library()

  set(_zmk_app_include_candidates
    ${ZEPHYR_BASE}/../app/include
    ${ZEPHYR_BASE}/../zmk/app/include
  )
  foreach(_inc ${_zmk_app_include_candidates})
    if(EXISTS ${_inc})
      zephyr_library_include_directories(${_inc})
      break()
    endif()
  endforeach()

  zephyr_library_sources(${_lalapad_sources})
endif()
